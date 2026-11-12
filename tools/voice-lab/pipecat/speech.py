"""Local Kokoro ONNX inference; espeak remains an executable (SPEC-011 R-5).

Uses the existing Arke model and per-voice style files, making a later Voxa
comparison use the same assets. No phonemizer shared library is loaded.
"""
import asyncio
import json
import subprocess
from pathlib import Path

import numpy as np
import onnxruntime as ort
from pipecat.frames.frames import TTSAudioRawFrame
from pipecat.services.tts_service import TTSService
from pipecat.services.settings import TTSSettings

# The model vocabulary, extracted from kokoro-onnx 0.6.1's config.json.
VOCAB = json.loads((Path(__file__).parent / "kokoro-vocab.json").read_text(encoding="utf-8"))


class KokoroEngine:
    def __init__(self, model: Path, voices: Path, espeak: Path):
        self.voices = voices
        self.espeak = espeak
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
        self.session = ort.InferenceSession(str(model), options, providers=["CPUExecutionProvider"])
        self.inputs = {item.name: item for item in self.session.get_inputs()}
        self.gate = asyncio.Lock()
        self.work = set()

    async def synthesize_async(self, text, voice):
        await self.gate.acquire()
        work = asyncio.create_task(asyncio.to_thread(self.synthesize, text, voice))
        self.work.add(work)
        def settled(done):
            self.work.discard(done)
            self.gate.release()
            if not done.cancelled():
                done.exception()
        work.add_done_callback(settled)
        # An interruption must return immediately to Pipecat. The native call owns
        # the lock until its completion callback, even after its caller is gone.
        return await asyncio.shield(work)

    async def close(self):
        await asyncio.gather(*self.work, return_exceptions=True)

    def synthesize(self, text: str, voice: str, speed: float = 1.0) -> bytes:
        if voice not in self.voice_names():
            raise ValueError("Unknown local Kokoro voice")
        phonemes = subprocess.run(
            [str(self.espeak), "--path=" + str(self.espeak.parent / "share"), "-q", "--ipa", "-v", "en-gb" if voice.startswith("b") else "en-us", "--stdin"],
            input=text, encoding="utf-8", capture_output=True, check=True, timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout.strip().replace("\n", ", ")
        if text.rstrip().endswith((".", "!", "?")):
            phonemes += text.rstrip()[-1]
        tokens = [VOCAB[char] for char in phonemes if char in VOCAB]
        if not tokens:
            return b""
        styles = np.fromfile(self.voices / f"{voice}.bin", dtype=np.float32).reshape(-1, 256)
        chunks = []
        for start in range(0, len(tokens), 500):
            part = tokens[start:start + 500]
            token_name = "tokens" if "tokens" in self.inputs else "input_ids"
            style_dtype = np.float16 if self.inputs["style"].type == "tensor(float16)" else np.float32
            feed = {
                token_name: np.array([[0, *part, 0]], dtype=np.int64),
                "style": styles[min(len(part), len(styles)) - 1].reshape(1, 256).astype(style_dtype),
                "speed": np.array([speed], dtype=np.float32),
            }
            audio = np.asarray(self.session.run(None, feed)[0], dtype=np.float32).ravel()
            chunks.append((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
        return b"".join(chunks)

    def voice_names(self):
        return sorted(path.stem for path in self.voices.glob("*.bin"))


class LocalKokoroTTS(TTSService):
    def __init__(self, engine: KokoroEngine, voice: str, emit):
        super().__init__(sample_rate=24000, settings=TTSSettings(model="kokoro-82m-quantized", voice=voice, language="en"))
        self.engine, self.voice, self.emit = engine, voice, emit

    async def run_tts(self, text: str, context_id: str):
        await self.start_ttfb_metrics()
        pcm = await self.engine.synthesize_async(text, self.voice)
        await self.stop_ttfb_metrics()
        await self.emit("tts-ready", {"characters": len(text), "audioSeconds": len(pcm) / 48000})
        for start in range(0, len(pcm), 960):
            yield TTSAudioRawFrame(pcm[start:start + 960], 24000, 1, context_id=context_id)
