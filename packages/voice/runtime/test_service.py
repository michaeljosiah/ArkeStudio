import asyncio
import base64
from contextlib import asynccontextmanager
import io
from pathlib import Path
import socket
import threading
from types import SimpleNamespace
import wave

import aiohttp
import av
import numpy as np
import pytest
import uvicorn

from engines import Engines, decode_audio
from service import InferenceLane, MAX_AUDIO_BYTES, create_app

TOKEN = "a" * 43


def wav_bytes():
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(np.zeros(2400, dtype="<i2").tobytes())
    return out.getvalue()


class FakeEngines:
    kokoro = whisper = True
    reasons = {"kokoro": "Local synthesis is unavailable.", "whisper": "Local recognition is unavailable."}
    def voices(self):
        return [{"id": "bf_emma", "label": "Emma", "engine": "kokoro", "language": "en-GB", "attributes": ["female"]}]
    def synthesize(self, text, voice, speed):
        if voice != "bf_emma":
            raise ValueError("bad voice")
        return wav_bytes()
    def transcribe(self, data, prompt, content_type=""):
        decode_audio(data, content_type)
        return prompt or "hello"


@asynccontextmanager
async def serving(engines=None, alignment=None):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    options = SimpleNamespace(port=port, capability=TOKEN)
    app = create_app(options, engines=engines or FakeEngines(), alignment=alignment)
    server = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        async with asyncio.timeout(5):
            while not server.started:
                await asyncio.sleep(.01)
        async with aiohttp.ClientSession(base_url=f"http://127.0.0.1:{port}", headers={"Authorization": "Bearer " + TOKEN}) as client:
            yield client
    finally:
        server.should_exit = True
        await task
        sock.close()


async def test_authentication_origin_and_batch_contract():
    async with serving() as client:
        async with client.get("/health", headers={"Authorization": ""}) as response:
            assert response.status == 401
        async with client.get("/health", headers={"Origin": "https://other.example"}) as response:
            assert response.status == 403
        async with client.get("/health", headers={"Host": "other.example"}) as response:
            assert response.status == 403
        async with client.get("/health") as response:
            health = await response.json()
            assert health["protocolVersion"] == 1
            assert health["engineStatus"]["whisper"]["ready"]
            assert not health["wordTiming"]["ready"]
            assert response.headers["Cache-Control"] == "no-store"
        async with client.get("/voices") as response:
            assert (await response.json())[0]["id"] == "bf_emma"
        async with client.post("/tts", json={"voice": "bf_emma", "text": "hello", "speed": 1}) as response:
            assert response.status == 200
            assert (await response.read()).startswith(b"RIFF")
        async with client.post("/stt", data=wav_bytes(), headers={"Content-Type": "audio/wav", "X-Voxa-Prompt": base64.b64encode("Maren Kest".encode()).decode()}) as response:
            assert response.status == 200
            assert await response.json() == {"text": "Maren Kest"}


async def test_independent_readiness_and_safe_failures():
    engines = FakeEngines()
    engines.kokoro = None
    async with serving(engines) as client:
        async with client.get("/health") as response:
            status = (await response.json())["engineStatus"]
            assert status["whisper"]["ready"] and not status["kokoro"]["ready"]
        async with client.post("/stt", data=wav_bytes(), headers={"Content-Type": "audio/wav"}) as response:
            assert response.status == 200
        async with client.post("/tts", json={"voice": "bf_emma", "text": "hello"}) as response:
            assert response.status == 503


async def test_browser_webm_is_decoded_and_streaming_body_limit_is_enforced(monkeypatch):
    out = io.BytesIO()
    with av.open(out, "w", format="webm") as container:
        stream = container.add_stream("libopus", rate=48000)
        frame = av.AudioFrame.from_ndarray(np.zeros((1, 4800), dtype=np.float32), format="fltp", layout="mono")
        frame.sample_rate = 48000
        for packet in [*stream.encode(frame), *stream.encode(None)]:
            container.mux(packet)
    assert len(decode_audio(out.getvalue())) > 1000
    async with serving() as client:
        async with client.post("/stt", data=out.getvalue(), headers={"Content-Type": "audio/webm"}) as response:
            assert response.status == 200
        monkeypatch.setattr("service.MAX_AUDIO_BYTES", 1024)
        async def chunks():
            yield b"x" * 1000
            yield b"x" * 25
        async with client.post("/stt", data=chunks(), headers={"Content-Type": "audio/webm"}) as response:
            assert response.status == 413


async def test_malformed_inputs_are_bounded_and_not_reflected():
    async with serving() as client:
        for payload in [{"voice": "bf_emma", "text": "x" * 4001}, {"voice": "bf_emma", "text": "hello", "speed": 0}]:
            async with client.post("/tts", json=payload) as response:
                assert response.status == 400
        async with client.post("/tts", data=b"x" * 32769, headers={"Content-Type": "application/json"}) as response:
            assert response.status == 413
        async with client.post("/stt", data=b"invalid private recording", headers={"Content-Type": "audio/wav"}) as response:
            assert response.status == 400
            assert "private recording" not in await response.text()
        for hint in ["!bad", base64.b64encode(b"x" * 201).decode(), base64.b64encode(b"bad\x00hint").decode(), base64.b64encode(b"\xff").decode()]:
            async with client.post("/stt", data=wav_bytes(), headers={"Content-Type": "audio/wav", "X-Voxa-Prompt": hint}) as response:
                assert response.status == 400
        async with client.post("/stt", data=b"", headers={"Content-Type": "text/plain"}) as response:
            assert response.status == 415


class Request:
    async def is_disconnected(self):
        return False


async def test_cancelled_observer_retains_native_lane_and_shutdown_waits():
    lane = InferenceLane()
    started, release, next_started = threading.Event(), threading.Event(), threading.Event()
    def native():
        started.set()
        release.wait(5)
        return "done"
    first = asyncio.create_task(lane.run(Request(), native))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        second = asyncio.create_task(lane.run(Request(), lambda: next_started.set()))
        await asyncio.sleep(.02)
        assert lane.gate.locked() and not next_started.is_set()
        second.cancel()
        await asyncio.gather(second, return_exceptions=True)
        close = asyncio.create_task(lane.close())
        await asyncio.sleep(.02)
        assert not close.done()
    finally:
        release.set()
        await lane.close()
    assert not lane.work
    assert not next_started.is_set()


def test_missing_models_do_not_attempt_downloads(tmp_path, monkeypatch):
    import faster_whisper
    calls = []
    def forbidden(*args, **kwargs):
        calls.append(args)
        raise AssertionError("Must not construct a downloader for missing local assets")
    monkeypatch.setattr(faster_whisper, "WhisperModel", forbidden)
    engines = Engines(tmp_path, tmp_path, tmp_path / "missing-espeak")
    assert engines.kokoro is None and engines.whisper is None
    assert not calls


def test_capability_is_required():
    for token in ("", "short", "x" * 42 + "\n"):
        with pytest.raises(ValueError, match="private speech capability"):
            create_app(SimpleNamespace(capability=token, port=1))


def test_raw_pcm_byte_order_and_incomplete_samples():
    for kind, dtype in [("audio/pcm", "<i2"), ("audio/L16", ">i2"), ("application/octet-stream", "<i2")]:
        samples = np.array([0, 16384, -16384], dtype=dtype)
        assert np.array_equal(decode_audio(samples.tobytes(), kind), np.array([0, .5, -.5], dtype=np.float32))
        with pytest.raises(ValueError):
            decode_audio(b"x", kind)


async def test_word_alignment_is_independent_and_ignores_recognition_hints():
    class Aligner:
        ready = True
        def transcribe(self, data, content_type):
            assert content_type == "audio/wav"
            decode_audio(data)
            return {"text": "Hello.", "seconds": 1, "engine": {"id": "whisper.cpp/dtw-word-boundaries-v1", "version": "fixture", "model": "fixture"},
                    "words": [{"text": "Hello.", "startSec": .1, "endSec": .8, "probability": .9}]}
    engines = FakeEngines()
    engines.whisper = None
    async with serving(engines, Aligner()) as client:
        async with client.get("/health") as response:
            assert (await response.json())["wordTiming"]["ready"]
        async with client.post("/stt/words", data=wav_bytes(), headers={"Content-Type": "audio/wav", "X-Voxa-Prompt": "!invalid-and-ignored"}) as response:
            assert response.status == 200
            assert (await response.json())["engine"]["id"] == "whisper.cpp/dtw-word-boundaries-v1"
    async with serving() as client:
        async with client.post("/stt/words", data=wav_bytes(), headers={"Content-Type": "audio/wav"}) as response:
            assert response.status == 503
