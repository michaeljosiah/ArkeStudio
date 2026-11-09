"""Local inference only. No model identifiers are allowed to trigger downloads."""
import io
import json
import os
from pathlib import Path
import subprocess
import wave

from decoder import decode_audio
import numpy as np
import onnxruntime as ort

VOICES = [
    ("af_bella", "Bella", "en-US", ["warm", "low", "even", "female"]),
    ("af_nicole", "Nicole", "en-US", ["bright", "quick", "female"]),
    ("am_michael", "Michael", "en-US", ["deep", "steady", "male"]),
    ("am_adam", "Adam", "en-US", ["dry", "measured", "male"]),
    ("bf_emma", "Emma", "en-GB", ["cool", "precise", "female", "coastal"]),
    ("bm_george", "George", "en-GB", ["low", "gravel", "male", "weathered"]),
]
MAX_SECONDS = 600
MAX_OUTPUT_BYTES = 16 * 1024**2




class Kokoro:
    """The audition's ONNX adapter, retaining the separate espeak executable boundary."""
    def __init__(self, root, espeak):
        self.root, self.espeak = root, espeak
        if not espeak.is_file():
            raise ValueError("The phonemizer is missing.")
        if not any((root / "voices" / (id + ".bin")).is_file() for id, *_ in VOICES):
            raise ValueError("The local voices are missing.")
        self.vocab = json.loads((Path(__file__).parent / "kokoro-vocab.json").read_text(encoding="utf-8"))
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
        self.session = ort.InferenceSession(str(root / "model_quantized.onnx"), options, providers=["CPUExecutionProvider"])
        self.inputs = {item.name: item for item in self.session.get_inputs()}

    def voices(self):
        return [dict(id=id, label=label, engine="kokoro", language=language, attributes=attributes)
                for id, label, language, attributes in VOICES if (self.root / "voices" / (id + ".bin")).is_file()]

    def synthesize(self, text, voice, speed):
        if voice not in {item["id"] for item in self.voices()}:
            raise ValueError("Unknown or missing local voice.")
        phonemes = subprocess.run(
            [str(self.espeak), "--path=" + str(self.espeak.parent / "share"), "-q", "--ipa", "-v",
             "en-gb" if voice.startswith("b") else "en-us", "--stdin"],
            input=text, encoding="utf-8", capture_output=True, check=True, timeout=15,
            env={key: os.environ[key] for key in ("SystemRoot", "WINDIR") if key in os.environ},
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout.strip().replace("\n", ", ")
        if text.rstrip().endswith((".", "!", "?")):
            phonemes += text.rstrip()[-1]
        tokens = [self.vocab[char] for char in phonemes if char in self.vocab]
        if not tokens:
            raise ValueError("The text contains no speakable words.")
        styles = np.fromfile(self.root / "voices" / (voice + ".bin"), dtype=np.float32).reshape(-1, 256)
        chunks, size = [], 0
        for start in range(0, len(tokens), 500):
            part = tokens[start:start + 500]
            feed = {
                "tokens" if "tokens" in self.inputs else "input_ids": np.array([[0, *part, 0]], dtype=np.int64),
                "style": styles[min(len(part), len(styles)) - 1].reshape(1, 256).astype(
                    np.float16 if self.inputs["style"].type == "tensor(float16)" else np.float32),
                "speed": np.array([speed], dtype=np.float32),
            }
            audio = np.asarray(self.session.run(None, feed)[0], dtype=np.float32).ravel()
            pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
            size += len(pcm)
            if size > MAX_OUTPUT_BYTES:
                raise ValueError("Generated speech exceeds its audio bound.")
            chunks.append(pcm)
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(24000)
            wav.writeframes(b"".join(chunks))
        return output.getvalue()


class Engines:
    def __init__(self, kokoro_root, whisper_model, espeak):
        self.kokoro = self.whisper = None
        self.reasons = {"kokoro": "Local synthesis is unavailable.", "whisper": "Local recognition is unavailable."}
        try:
            self.kokoro = Kokoro(kokoro_root, espeak)
        except Exception:
            pass  # Readiness must not expose paths or native exception contents.
        try:
            if not all((whisper_model / name).is_file() for name in ("model.bin", "config.json", "tokenizer.json")):
                raise ValueError("The verified recognizer model is missing.")
            from faster_whisper import WhisperModel
            self.whisper = WhisperModel(str(whisper_model), device="cpu", compute_type="int8", cpu_threads=4, local_files_only=True)
        except Exception:
            pass

    def voices(self):
        return self.kokoro.voices() if self.kokoro else []

    def synthesize(self, text, voice, speed):
        return self.kokoro.synthesize(text, voice, speed)

    def transcribe(self, data, prompt, content_type=""):
        segments, _ = self.whisper.transcribe(decode_audio(data, content_type), language="en", initial_prompt=prompt, beam_size=1)
        text, size = [], 0
        for segment in segments:
            size += len(segment.text)
            if size > 64000:
                raise ValueError("The transcript exceeds its supported bound.")
            text.append(segment.text.strip())
        return " ".join(text).strip()
