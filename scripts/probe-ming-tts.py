"""Offline Ming qualification, before adding a Studio reader (SPEC-046 section 2.6).

The parent bounds the inference process and records cancellation/release separately from
successful generation. No world is written, no cloud reader is called, and no audio quality
judgement is inferred from successful execution. See docs/development/ming-tts-audition.md.
The shared-runtime vocoder adapter derives from inclusionAI's MIT code; see
licenses/ming-audition-MIT.txt for its copyright and permission notice.
"""

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import random
import re
import subprocess
import sys
import time
import traceback


UPSTREAM_REVISION = "028c1eace193e7acdb256453da89b6e9207e052b"


def digest(path):
    with open(path, "rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def append(path, event):
    with open(path, "a", encoding="utf-8") as target:
        target.write(json.dumps({"at": time.time(), **event}, ensure_ascii=False) + "\n")
        target.flush()
        os.fsync(target.fileno())


def gpu():
    try:
        result = subprocess.run([
            "nvidia-smi", "--query-gpu=name,memory.total,memory.free,driver_version",
            "--format=csv,noheader",
        ], capture_output=True, text=True, timeout=10, check=True)
        return result.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def worker_environment(output, environ):
    # Windows normalizes Python's environment keys to uppercase; dropping SYSTEMROOT
    # prevents Winsock (and hence torch's asyncio import) from initializing.
    allowed = {"SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "WINDIR", "PATH",
               "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME",
               "LANG", "LC_ALL", "LD_LIBRARY_PATH", "VIRTUAL_ENV"}
    env = {key: value for key, value in environ.items() if key.upper() in allowed}
    env.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", PYTHONUTF8="1",
               HF_HUB_DISABLE_TELEMETRY="1", TOKENIZERS_PARALLELISM="false",
               HF_HOME=str((output / "hf-cache").resolve()),
               TRITON_CACHE_DIR=str((output.parent / "triton-cache").resolve()),
               TORCHINDUCTOR_CACHE_DIR=str((output.parent / "inductor-cache").resolve()))
    return env


def load_suite(path, pattern):
    suite = json.loads(path.read_text(encoding="utf-8"))
    cases = suite["cases"]
    seen = set()
    for case in cases:
        key = case["id"]
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,95}", key) or key in seen:
            raise ValueError("case ids must be unique, portable filename stems")
        seen.add(key)
        if not isinstance(case["request"].get("text"), str) or not case["request"]["text"].strip():
            raise ValueError(f"{key}: text is required")
        if "output_path" in case["request"]:
            raise ValueError(f"{key}: output paths belong to the runner")
        reference = case["request"].get("prompt_wav_path")
        if reference is not None:
            if not isinstance(reference, str):
                raise ValueError(f"{key}: this probe accepts one reference per case")
            reference = (path.parent / reference).resolve()
            if not reference.is_file():
                raise ValueError(f"{key}: missing reference")
            case["request"]["prompt_wav_path"] = str(reference)
            case["referenceSha256"] = digest(reference)
    cases = [case for case in cases if re.search(pattern, case["id"])]
    if not cases:
        raise ValueError("no cases selected")
    return suite, cases


def checkpoint_weights(model, variant):
    if variant == "0.5b":
        names = ["model.safetensors"]
    else:
        index = json.loads((model / "model.safetensors.index.json").read_text(encoding="utf-8"))
        names = sorted(set(index["weight_map"].values()))
        if not names or any(not re.fullmatch(r"model-[0-9]+-of-[0-9]+\.safetensors", name) for name in names):
            raise ValueError("invalid checkpoint shard filenames")
    files = [model / name for name in names]
    for path in files:
        if not path.is_file():
            raise ValueError(f"missing checkpoint file: {path.name}")
    return files


def tiny_request(request, seed):
    # Task APIs differ; preserve the reference/text/seed and any explicit decode ceiling.
    # Record the mapped request rather than hiding model-specific field changes.
    task = request["task"].upper()
    mapped = {"task": "seed" if task == "TTS" else task.lower(),
              "text": request["text"], "seed": seed, "log_every_n_steps": 10}
    if task == "TTS" and re.search(r"\[[^\]]+\]", request["text"]):
        mapped["task"] = "paralinguistic"
    if request.get("prompt_wav_path") is not None:
        mapped["prompt_wav"] = request["prompt_wav_path"]
    # Tiny only trains the target-language line for its cloning/language tasks.
    # Its resolver rejects that line for basic, emotion and freeform requests,
    # even though the 0.5B API accepts language_id for those same task names.
    if mapped["task"] in {"seed", "paralinguistic", "multilingual"} and "language_id" in request:
        mapped["target_language"] = request["language_id"]
    for source, target in (("prompt_text", "prompt_text"),
                           ("instruction", "instruction"), ("cfg", "cfg_scale"),
                           ("temperature", "temperature"), ("sigma", "sigma"),
                           ("max_decode_steps", "max_decode_steps")):
        if source in request:
            mapped[target] = request[source]
    mapped.update(request.get("controls", {}))
    return mapped


def worker(args):
    # Imports happen only in the worker, so validation and watchdog need no ML environment.
    sys.path.insert(0, str(args.upstream.resolve()))
    if args.overlay:
        sys.path.insert(0, str(args.overlay.resolve()))
        if args.variant == "tiny":
            os.environ["CC"] = str(args.overlay.resolve() / "triton/runtime/tcc/tcc.exe")
    if args.python_sdk:
        import triton.windows_utils as triton_windows
        sdk = args.python_sdk.resolve()
        triton_windows.find_python = lambda: [str(sdk / "libs")]
        os.environ["TRITON_CUDACRT_PATH"] = str(sdk / "include")
        import triton.runtime.build as triton_build
        triton_build.find_python = triton_windows.find_python
    import numpy as np
    import soundfile as sf
    import torch

    if args.shared_runtime_adapters:
        import types
        import torchaudio
        def reference_load(path, backend=None):
            if backend != "soundfile":
                raise ValueError("The Ming adapter supports soundfile reference reads only")
            data, rate = sf.read(path, dtype="float32", always_2d=True)
            return torch.from_numpy(data.T.copy()), rate
        proxy = types.SimpleNamespace(load=reference_load, transforms=torchaudio.transforms)
        if args.variant == "tiny":
            import ming_tiny.inference as inference
            from ming_tiny.istft import ISTFTHead
        else:
            import ming_tts as inference
            from audio_tokenizer.istft import ISTFTHead
        inference.torchaudio = proxy
        def complex_audio_forward(self, x, audio_buffer=None, window_buffer=None,
                                  streaming=False, last_chunk=False):
            prediction = self.out(x).transpose(1, 2)
            magnitude, phase = prediction.chunk(2, dim=1)
            magnitude = torch.exp(magnitude).clamp(max=1e2)
            # Preserve the native BF16 exp/trig, then avoid unsupported BComplex32 CUDA mul.
            spectrum = torch.complex(torch.cos(phase).float(), torch.sin(phase).float()) * magnitude.float()
            audio, audio_buffer, window_buffer = self.istft(spectrum, audio_buffer=audio_buffer,
                window_buffer=window_buffer, streaming=streaming, last_chunk=last_chunk)
            return audio.unsqueeze(1), prediction, audio_buffer, window_buffer
        ISTFTHead.forward = complex_audio_forward

    torch.cuda.set_device(args.device)
    _, cases = load_suite(args.suite, args.case)
    journal = args.out / "results.jsonl"
    packages = ["torch", "torchaudio", "transformers", "tokenizers", "accelerate",
                "diffusers", "x-transformers", "onnxruntime", "soundfile", "numpy"]
    if args.variant == "tiny":
        packages = [name for name in packages if name != "diffusers"] + ["fla-core", "triton-windows", "safetensors"]
    append(journal, {"event": "runtime", "python": sys.version, "platform": platform.platform(),
                     "packages": {name: importlib.metadata.version(name) for name in packages},
                     "gpu": gpu(), "device": args.device, "variant": args.variant,
                     "gpuName": torch.cuda.get_device_name(),
                     "gpuTotalBytes": torch.cuda.get_device_properties(args.device).total_memory})
    started = time.perf_counter()
    torch.cuda.synchronize()
    try:
        if args.variant == "tiny":
            from ming_tiny import MingTinyTTS
            model = MingTinyTTS.from_pretrained(str(args.model.resolve()), device=args.device)
        else:
            from ming_tts import MingTTS
            model = MingTTS(str(args.model.resolve()), device=args.device,
                            text_normalization=args.text_normalization, cache_prompts=False)
    except Exception as error:
        append(journal, {"event": "load-failed", "seconds": time.perf_counter() - started,
                         "error": f"{type(error).__name__}: {error}"})
        raise
    torch.cuda.synchronize()
    append(journal, {"event": "loaded", "seconds": time.perf_counter() - started,
                     "sampleRate": model.sample_rate,
                     "allocatedBytes": torch.cuda.memory_allocated(),
                     "reservedBytes": torch.cuda.memory_reserved(), "gpu": gpu(),
                     "textNormalization": args.text_normalization if args.variant == "0.5b" else None,
                     "promptCache": False if args.variant == "0.5b" else None})
    failures = 0
    for case in cases:
        request = case["request"]
        seed = case.get("seed", 1895)
        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)
        torch.backends.cudnn.deterministic = True
        torch.backends.cudnn.benchmark = False
        torch.cuda.reset_peak_memory_stats()
        event = {"id": case["id"], "seed": seed, "request": request,
                 "referenceSha256": case.get("referenceSha256"),
                 "listening": "pending", "wordsCheck": "pending"}
        if args.variant == "tiny":
            event["executionRequest"] = tiny_request(request, seed)
        append(journal, {"event": "case-start", **event})
        started = time.perf_counter()
        try:
            if args.variant == "tiny":
                generated = model.generate(**event["executionRequest"])
                waveform = generated.waveform
                event["decoder"] = {"stopped": generated.stopped,
                    "steps": len(generated.stop_probabilities),
                    "lastStopProbability": generated.stop_probabilities[-1] if generated.stop_probabilities else None,
                    "latentShape": list(generated.latents.shape),
                    "promptTokenCount": generated.prompt_token_count,
                    "promptLatentSteps": generated.prompt_latent_steps}
            else:
                waveform = model.synthesize(**request)
            audio = waveform.detach().cpu().float().numpy().reshape(-1)
            torch.cuda.synchronize()
            seconds = time.perf_counter() - started
            duration = len(audio) / model.sample_rate
            if duration <= 0 or not np.isfinite(audio).all():
                raise ValueError("empty or non-finite waveform")
            output = args.out / (case["id"] + ".wav")
            # Explicit PCM16 avoids making the decoder's output format an implicit dependency.
            sf.write(output, audio, model.sample_rate, subtype="PCM_16")
            append(journal, {"event": "case-result", **event, "outcome": "generated",
                "file": output.name, "sha256": digest(output), "seconds": seconds,
                "audioSeconds": duration, "rtf": seconds / duration,
                "sampleRate": model.sample_rate, "channels": 1,
                "peak": float(np.max(np.abs(audio))),
                "rms": math.sqrt(float(np.mean(audio.astype(np.float64) ** 2))),
                "clippedFraction": float(np.mean(np.abs(audio) >= 1)),
                "peakAllocatedBytes": torch.cuda.max_memory_allocated(),
                "peakReservedBytes": torch.cuda.max_memory_reserved()})
            print(f"{case['id']}: {duration:.2f}s audio / {seconds:.2f}s compute", flush=True)
        except Exception as error:
            failures += 1
            append(journal, {"event": "case-result", **event, "outcome": "failed",
                             "seconds": time.perf_counter() - started,
                             "error": f"{type(error).__name__}: {error}"})
            traceback.print_exc()
            if isinstance(error, torch.cuda.OutOfMemoryError):
                torch.cuda.empty_cache()
    return int(failures > 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--variant", choices=("0.5b", "tiny"), default="0.5b")
    parser.add_argument("--suite", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--case", default=".", help="regular expression over case ids")
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--timeout", type=float, default=900, help="whole worker deadline, seconds")
    parser.add_argument("--cancel-after", type=float, help="terminate this probe's worker after first case starts")
    parser.add_argument("--text-normalization", action="store_true", help="requires optional pynini")
    parser.add_argument("--overlay", type=Path, help="isolated Ming packages; never pip-install into the shared interpreter")
    parser.add_argument("--python-sdk", type=Path, help="matching Windows Python headers/libs for Tiny's Triton compiler")
    parser.add_argument("--shared-runtime-adapters", action="store_true", help="process-local SoundFile and complex64 adapters for the qualified managed bundle")
    parser.add_argument("--check", action="store_true", help="validate local inputs without loading ML libraries")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not math.isfinite(args.timeout) or args.timeout <= 0 or (args.cancel_after is not None and
            (not math.isfinite(args.cancel_after) or args.cancel_after <= 0)):
        parser.error("deadlines must be positive")
    if not re.fullmatch(r"cuda:\d+", args.device):
        parser.error("the reference probe requires an explicit CUDA device, e.g. cuda:0")
    _, cases = load_suite(args.suite.resolve(), args.case)
    revision = subprocess.run(["git", "-C", str(args.upstream), "rev-parse", "HEAD"],
                              capture_output=True, text=True, check=True).stdout.strip()
    if revision != UPSTREAM_REVISION:
        raise ValueError("unexpected upstream revision; review changes before updating the probe")
    dirty = subprocess.run(["git", "-C", str(args.upstream), "status", "--porcelain", "--untracked-files=no"],
                           capture_output=True, text=True, check=True).stdout.strip()
    if dirty:
        raise ValueError("tracked upstream source differs from the pinned revision")
    for filename in ("config.json", "campplus.onnx"):
        if not (args.model / filename).is_file():
            raise ValueError(f"missing checkpoint file: {filename}")
    weights = checkpoint_weights(args.model, args.variant)
    if args.variant == "tiny" and args.text_normalization:
        parser.error("--text-normalization belongs to the 0.5b runtime")
    if args.check:
        print(json.dumps({"cases": [case["id"] for case in cases], "upstream": revision}))
        return 0
    if args.worker:
        return worker(args)
    # Refuse reuse: a second run must not silently mix results or overwrite an audition.
    args.out.mkdir(parents=True, exist_ok=False)
    journal = args.out / "results.jsonl"
    append(journal, {"event": "start", "upstream": revision,
                     "runnerSha256": digest(Path(__file__)), "suiteSha256": digest(args.suite),
                     "modelConfigSha256": digest(args.model / "config.json"),
                     "variant": args.variant,
                     "weightFiles": [{"name": path.name, "bytes": path.stat().st_size,
                                      "sha256": digest(path)} for path in weights],
                     "speakerEncoderSha256": digest(args.model / "campplus.onnx"),
                     "cases": [case["id"] for case in cases], "gpuBefore": gpu()})
    command = [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:], "--worker"]
    # These are local-only inference runs. Dependencies/model assets must already be downloaded.
    env = worker_environment(args.out, os.environ)
    if args.overlay and args.variant == "tiny":
        env["CC"] = str(args.overlay.resolve() / "triton/runtime/tcc/tcc.exe")
        env["USER"] = "arke-ming-probe"
    reason = None
    case_started = None
    started = time.monotonic()
    with open(args.out / "worker.log", "w", encoding="utf-8") as log:
        process = subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            while process.poll() is None:
                now = time.monotonic()
                if case_started is None and '"event": "case-start"' in journal.read_text(encoding="utf-8"):
                    case_started = now
                if now - started > args.timeout:
                    reason = "timed-out"
                if args.cancel_after is not None and case_started is not None and now - case_started > args.cancel_after:
                    reason = "cancelled"
                if reason:
                    process.kill()
                    break
                time.sleep(0.25)
            code = process.wait(timeout=10)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
    append(journal, {"event": "exit", "outcome": reason or ("completed" if code == 0 else "failed"),
                     "exitCode": code, "seconds": time.monotonic() - started,
                     "gpuAfter": gpu(), "memoryObservation": "machine-wide, includes other applications"})
    print(f"{reason or 'worker exited'}: {code}; results: {journal}")
    # Cancellation is measured evidence, never counted as successful synthesis.
    return 0 if reason == "cancelled" else (1 if reason else code)


if __name__ == "__main__":
    sys.exit(main())
