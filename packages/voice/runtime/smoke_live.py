"""Opt-in real audio pipeline qualification, without a cloud model or recording files."""
import argparse
import asyncio
import base64
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time

import aiohttp
import numpy as np
from websockets.asyncio.client import connect

from engines import decode_audio


async def check(options):
    with socket.socket() as reserve:
        reserve.bind(("127.0.0.1", 0))
        port = reserve.getsockname()[1]
    capability = secrets.token_urlsafe(32)
    headers = {"Authorization": "Bearer " + capability}
    env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR") if key in os.environ}
    env.update(ARKE_SPEECH_CAPABILITY=capability, HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    args = [sys.executable, "-E", "-s", "-B", str(Path(__file__).with_name("service.py")), "--port", str(port)]
    for name in ("kokoro", "whisper", "espeak"):
        args.extend(["--" + name, str(getattr(options, name).resolve())])
    process = subprocess.Popen(args, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        async with aiohttp.ClientSession(base_url=f"http://127.0.0.1:{port}", headers=headers, timeout=aiohttp.ClientTimeout(total=60)) as client:
            deadline = time.monotonic() + 60
            while True:
                if process.poll() is not None:
                    raise RuntimeError("Speech host exited during readiness")
                try:
                    response = await client.get("/health")
                    if response.status == 200:
                        break
                except aiohttp.ClientError:
                    pass
                if time.monotonic() > deadline:
                    raise RuntimeError("Speech readiness timed out")
                await asyncio.sleep(.1)
            response = await client.post("/tts", json={"voice": "bf_emma", "text": "Hello Arke. Can you hear me clearly?"})
            response.raise_for_status()
            samples = decode_audio(await response.read(), "audio/wav")
        pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
        async with connect(f"ws://127.0.0.1:{port}/live", additional_headers=headers, max_size=65536, open_timeout=10) as ws:
            await ws.send(json.dumps({"voice": "bf_emma", "silenceMs": 650}))
            async with asyncio.timeout(30):
                while json.loads(await ws.recv())["type"] != "ready":
                    pass
            async def feed():
                for data in (b"\0" * 16000, pcm, b"\0" * 64000):
                    for at in range(0, len(data), 1280):
                        chunk = data[at:at + 1280]
                        await ws.send(json.dumps({"type": "audio", "audio": base64.b64encode(chunk).decode()}))
                        await asyncio.sleep(len(chunk) / 32000)
            feeding = asyncio.create_task(feed())
            heard, audio_bytes = False, 0
            async with asyncio.timeout(60):
                while True:
                    message = json.loads(await ws.recv())
                    if message["type"] == "turn":
                        assert "hear" in message["text"].lower(), "Real recognition missed the phrase"
                        heard = True
                        await ws.send(json.dumps({"type": "delta", "turn": message["turn"], "text": "Hello. I can hear you clearly."}))
                        await ws.send(json.dumps({"type": "done", "turn": message["turn"]}))
                    elif message["type"] == "audio":
                        audio_bytes += len(base64.b64decode(message["audio"]))
                    elif message["type"] == "failed":
                        raise RuntimeError("Live pipeline failed")
                    elif heard and audio_bytes and message["type"] == "state" and message.get("state") == "listening":
                        break
            await feeding
            assert audio_bytes > 4800
        print(f"PASS: authenticated live VAD -> real local Whisper -> host reply -> Kokoro playback ({audio_bytes} PCM bytes); no saved audio")
        print("This verifies the audio pipeline; cloud adapter, physical microphone and speaker echo require separate checks.")
    finally:
        process.terminate()
        await asyncio.to_thread(process.wait, 15)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("kokoro", "whisper", "espeak"):
        parser.add_argument("--" + name, type=Path, required=True)
    asyncio.run(check(parser.parse_args()))
