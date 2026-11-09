"""Offline real-model HTTP smoke; no microphone, speakers, cloud or saved audio."""
import os
os.environ["HF_HUB_OFFLINE"] = "1"

import argparse
import asyncio
import io
from pathlib import Path
import secrets
import socket
import wave

import aiohttp
import numpy as np
import uvicorn

from service import create_app


async def main(options):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    options.port = sock.getsockname()[1]
    options.capability = secrets.token_urlsafe(32)
    server = uvicorn.Server(uvicorn.Config(create_app(options), log_level="critical", access_log=False))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        async with asyncio.timeout(90):
            while not server.started:
                await asyncio.sleep(.1)
        async with aiohttp.ClientSession(base_url=f"http://127.0.0.1:{options.port}", headers={"Authorization": "Bearer " + options.capability}) as client:
            async with client.get("/health") as response:
                health = await response.json()
                assert all(row["ready"] for row in health["engineStatus"].values()), "Verified speech assets are not ready"
            async with client.post("/tts", json={"voice": "bf_emma", "text": "Hello, this is a local voice test."}) as response:
                assert response.status == 200, "Local synthesis failed"
                audio = await response.read()
                with wave.open(io.BytesIO(audio)) as wav:
                    assert wav.getframerate() == 24000
                    assert np.max(np.abs(np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.int32))) > 200
            async with client.post("/stt", data=audio, headers={"Content-Type": "audio/wav"}) as response:
                assert response.status == 200, "Local recognition failed"
                text = (await response.json())["text"]
                assert "voice test" in text.lower(), "Recognition did not return the synthetic phrase"
            print("PASS: authenticated local Kokoro WAV -> Faster Whisper recognition; offline, no saved audio", flush=True)
    finally:
        server.should_exit = True
        await task
        sock.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--kokoro", type=Path, required=True)
    parser.add_argument("--whisper", type=Path, required=True)
    parser.add_argument("--espeak", type=Path, required=True)
    asyncio.run(main(parser.parse_args()))
