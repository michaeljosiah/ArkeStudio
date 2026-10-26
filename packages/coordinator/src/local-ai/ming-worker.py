"""Offline Ming worker. See licenses/ming-audition-MIT.txt for the adapted ISTFT code.

All paths come from the host. Dependencies are immutable, hash-locked archives extracted into
this disposable batch, never into ComfyUI. One model instance serves every chunk in the batch.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import random
import shutil
import sys
import types
import zipfile


LANGUAGES = {"en": "English", "zh": "Chinese", "ja": "Japanese", "ko": "Korean",
             "fr": "French", "de": "German", "es": "Spanish", "it": "Italian",
             "pt": "Portuguese", "ru": "Russian"}


class MingWorkerRefusal(ValueError):
    """A controlled, path-free reason safe to show on the queued read."""


def sha256(path):
    with open(path, "rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def extract_verified(archive, expected, target, prefix="", sdk=False):
    if archive.stat().st_size != expected["bytes"] or sha256(archive) != expected["sha256"]:
        raise MingWorkerRefusal("Ming dependency verification failed: " + archive.name)
    total = 0
    with zipfile.ZipFile(archive) as source:
        members = source.infolist()
        if len(members) > 40000:
            raise MingWorkerRefusal("Ming archive has too many entries")
        for member in members:
            name = member.filename
            if "\\" in name or ":" in name or "\0" in name:
                raise MingWorkerRefusal("Unsafe Ming archive path")
            path = PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts or (member.external_attr >> 16) & 0o170000 == 0o120000:
                raise MingWorkerRefusal("Unsafe Ming archive entry")
            if prefix:
                if not name.startswith(prefix):
                    raise MingWorkerRefusal("Ming source root does not match its revision")
                name = name[len(prefix):]
            if sdk:
                if not name.startswith(("tools/include/", "tools/libs/")):
                    continue
                name = name[len("tools/"):]
            if not name or member.is_dir():
                continue
            total += member.file_size
            if member.file_size > 512 * 1024 * 1024 or total > 2 * 1024 * 1024 * 1024:
                raise MingWorkerRefusal("Ming archive exceeds its extraction limit")
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with source.open(member) as data, open(destination, "xb") as output:
                shutil.copyfileobj(data, output, 1024 * 1024)


def task_request(variant, text, reference, transcript, language, instruction, seed):
    if language not in LANGUAGES:
        raise MingWorkerRefusal("This recording language has not been qualified for Ming")
    if not transcript or not transcript.strip():
        raise MingWorkerRefusal("Ming needs the exact words spoken in the reference recording")
    if variant == "dense":
        request = {"task": "FREEFORM" if instruction else "TTS", "text": text,
                   "prompt_wav_path": reference, "use_spk_emb": True,
                   "language_id": LANGUAGES[language], "max_decode_steps": 1000}
    else:
        request = {"task": "freeform" if instruction else "seed", "text": text,
                   "prompt_wav": reference, "seed": seed, "max_decode_steps": 1000, "log_every_n_steps": 10}
        if not instruction:
            request["target_language"] = LANGUAGES[language]
    if instruction:
        # FREEFORM is speaker-only; a transcript is invalid for this task. Never prepend it
        # to the spoken text. The same original recording conditions every generated chunk.
        request["instruction"] = instruction
    else:
        request["prompt_text"] = transcript
    return request


def validate_audio_length(text, sample_count, sample_rate):
    """Conservative omission screen, not transcription or proof that every word was spoken."""
    words = len(text.split())
    if words >= 12 and sample_count / sample_rate < words / 8:
        raise MingWorkerRefusal("Ming stopped too early for this passage. Try a shorter passage or the 0.5B reader.")


def adapt_runtime(variant):
    import torch
    import soundfile as sf
    import torchaudio

    def reference_load(path, backend=None):
        if backend != "soundfile":
            raise MingWorkerRefusal("Only SoundFile reference reads are supported")
        data, rate = sf.read(path, dtype="float32", always_2d=True)
        return torch.from_numpy(data.T.copy()), rate

    if variant == "tiny":
        import ming_tiny.inference as inference
        from ming_tiny.istft import ISTFTHead
    else:
        import ming_tts as inference
        from audio_tokenizer.istft import ISTFTHead
    inference.torchaudio = types.SimpleNamespace(load=reference_load, transforms=torchaudio.transforms)

    def complex_audio_forward(self, x, audio_buffer=None, window_buffer=None, streaming=False, last_chunk=False):
        prediction = self.out(x).transpose(1, 2)
        magnitude, phase = prediction.chunk(2, dim=1)
        magnitude = torch.exp(magnitude).clamp(max=1e2)
        spectrum = torch.complex(torch.cos(phase).float(), torch.sin(phase).float()) * magnitude.float()
        audio, audio_buffer, window_buffer = self.istft(spectrum, audio_buffer=audio_buffer,
            window_buffer=window_buffer, streaming=streaming, last_chunk=last_chunk)
        return audio.unsqueeze(1), prediction, audio_buffer, window_buffer
    ISTFTHead.forward = complex_audio_forward


def main(request, assets):
    if request.get("schemaVersion") != 1 or request["variant"] not in ("dense", "tiny"):
        raise MingWorkerRefusal("Unsupported Ming request")
    chunks = request["chunks"]
    if not chunks or len(chunks) > 100 or any(not isinstance(text, str) or not text.strip() or len(text) > 240 or len(text.split()) > 40 for text in chunks):
        raise MingWorkerRefusal("Invalid Ming narration chunks")
    if sum(len(text) for text in chunks) > 1200:
        raise MingWorkerRefusal("Ming batch exceeds its text budget")
    if sys.version_info[:2] != (3, 13):
        raise MingWorkerRefusal("Ming requires the qualified managed Python 3.13 runtime")
    import torch
    if torch.__version__ != "2.14.0+cu130" or not torch.cuda.is_available():
        raise MingWorkerRefusal("Ming requires the qualified shared PyTorch/CUDA installation")
    batch = Path(request["output"]).parent
    runtime = Path(request["runtime"])
    variant = request["variant"]
    source = batch / "source"
    overlay = batch / "overlay"
    extract_verified(runtime / assets["source"]["file"], assets["source"], source,
                     prefix="Ming-3.0-tts-" + assets["sourceRevision"] + "/")
    for wheel in assets["variants"][variant]["wheels"]:
        extract_verified(runtime / wheel["file"], wheel, overlay)
    sys.path.insert(0, str(source))
    sys.path.insert(0, str(overlay))
    if variant == "tiny":
        sdk = batch / "sdk"
        extract_verified(runtime / assets["sdk"]["file"], assets["sdk"], sdk, sdk=True)
        import triton.windows_utils as triton_windows
        triton_windows.find_python = lambda: [str(sdk / "libs")]
        os.environ["TRITON_CUDACRT_PATH"] = str(sdk / "include")
        os.environ["CC"] = str(overlay / "triton/runtime/tcc/tcc.exe")
        import triton.runtime.build as triton_build
        triton_build.find_python = triton_windows.find_python
    import numpy as np
    import soundfile as sf
    adapt_runtime(variant)
    torch.cuda.set_device("cuda:0")
    info = sf.info(request["reference"])
    if not math.isfinite(info.duration) or info.duration <= 0 or info.duration > 30:
        raise MingWorkerRefusal("Ming requires a reference recording of at most 30 seconds")
    if variant == "dense":
        from ming_tts import MingTTS
        model = MingTTS(request["weights"], device="cuda:0", text_normalization=False, cache_prompts=False)
    else:
        from ming_tiny import MingTinyTTS
        model = MingTinyTTS.from_pretrained(request["weights"], device="cuda:0")
    audio = []
    for index, text in enumerate(chunks):
        seed = request["seed"]
        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)
        torch.backends.cudnn.deterministic = True
        torch.backends.cudnn.benchmark = False
        kwargs = task_request(variant, text, request["reference"], request["transcript"],
                              request["language"], request.get("instructions"), seed)
        if variant == "dense":
            waveform = model.synthesize(**kwargs)
        else:
            result = model.generate(**kwargs)
            if not result.stopped:
                raise MingWorkerRefusal("Ming reached its decode ceiling before finishing a chunk. Try a shorter passage.")
            waveform = result.waveform
        samples = waveform.detach().cpu().float().numpy().reshape(-1)
        if not samples.size or not np.isfinite(samples).all():
            raise MingWorkerRefusal("Ming returned empty or non-finite audio")
        validate_audio_length(text, samples.size, model.sample_rate)
        if sum(part.size for part in audio) + samples.size > model.sample_rate * 600:
            raise MingWorkerRefusal("Ming output exceeds ten minutes")
        if index:
            audio.append(np.zeros(round(model.sample_rate * 0.08), dtype=np.float32))
        audio.append(samples)
        print(f"Ming chunk {index + 1}/{len(chunks)} complete", flush=True)
    sf.write(request["output"], np.concatenate(audio), model.sample_rate, subtype="PCM_16")
    (batch / "result.json").write_text(json.dumps({"completedChunks": len(chunks), "sampleRate": model.sample_rate}), encoding="utf8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    args = parser.parse_args()
    try:
        main(json.loads(args.request.read_text(encoding="utf8")), json.loads(args.assets.read_text(encoding="utf8")))
    except Exception as error:
        reason = str(error) if isinstance(error, MingWorkerRefusal) else "Ming could not generate this reading. Check its model installation and private worker diagnostics."
        (args.request.parent / "failure.json").write_text(json.dumps({"reason": reason[:500]}), encoding="utf8")
        raise
