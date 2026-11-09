"""Private local speech protocol. Cloud sessions and application jobs belong to Studio."""
import argparse
import asyncio
import base64
from contextlib import asynccontextmanager
import os
from pathlib import Path
import platform
import re
import secrets
import struct

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from engines import Engines

MAX_AUDIO_BYTES = 64 * 1024**2


class Synthesis(BaseModel):
    model_config = ConfigDict(extra="ignore", allow_inf_nan=False)
    voice: str = Field(min_length=1, max_length=40)
    text: str = Field(min_length=1, max_length=4000)
    speed: float = Field(default=1, gt=0, le=3)


class InferenceLane:
    """A cancelled observer cannot release a native call's model reservation."""
    def __init__(self):
        self.gate, self.work, self.closing = asyncio.Lock(), set(), False

    async def run(self, request, function, *args):
        if self.closing:
            raise HTTPException(503, "Local speech is stopping.")
        if len(self.work) >= 4:
            raise HTTPException(429, "Local speech is busy.")
        started = False
        async def execute():
            nonlocal started
            async with self.gate:
                if self.closing:
                    raise HTTPException(503, "Local speech is stopping.")
                started = True
                return await asyncio.to_thread(function, *args)
        work = asyncio.create_task(execute())
        self.work.add(work)
        def settled(done):
            self.work.discard(done)
            if not done.cancelled():
                done.exception()
        work.add_done_callback(settled)
        async def disconnected():
            while not await request.is_disconnected():
                await asyncio.sleep(.1)
        watcher = asyncio.create_task(disconnected())
        try:
            done, _ = await asyncio.wait([work, watcher], return_when=asyncio.FIRST_COMPLETED)
            if watcher in done:
                raise HTTPException(499, "The speech requester disconnected.")
            return work.result()
        finally:
            if not started:
                work.cancel()
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)

    async def close(self):
        self.closing = True
        await asyncio.gather(*self.work, return_exceptions=True)


async def read_body(request, limit):
    length = request.headers.get("content-length")
    if length is not None and (not length.isdecimal() or int(length) > limit):
        raise HTTPException(413, "The speech request exceeds its byte bound.")
    body = bytearray()
    try:
        async with asyncio.timeout(15):
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > limit:
                    raise HTTPException(413, "The speech request exceeds its byte bound.")
    except TimeoutError:
        raise HTTPException(408, "The speech request body timed out.") from None
    return bytes(body)


def recognition_hint(request):
    header = request.headers.get("x-voxa-prompt")
    if header is None:
        return None
    try:
        if len(header) > 268:
            raise ValueError()
        data = base64.b64decode(header, validate=True)
        text = data.decode("utf-8", errors="strict")
        if len(data) > 200 or "\0" in text:
            raise ValueError()
        return text if text.strip() else None
    except (ValueError, UnicodeError):
        raise HTTPException(400, "Invalid local recognition hint.") from None


def create_app(options, engines=None):
    if not options.capability or not re.fullmatch(r"[A-Za-z0-9_-]{43}", options.capability):
        raise ValueError("A fresh private speech capability is required.")
    lane = InferenceLane()
    machine = platform.machine().lower()
    if struct.calcsize("P") != 8 or machine not in ("amd64", "x86_64", "arm64", "aarch64"):
        raise ValueError("Unsupported local speech process architecture.")
    architecture = "arm64" if machine in ("arm64", "aarch64") else "x64"
    @asynccontextmanager
    async def lifespan(app):
        app.state.engines = engines or await asyncio.to_thread(Engines, options.kokoro, options.whisper, options.espeak)
        try:
            yield
        finally:
            await lane.close()
    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.lane = lane

    @app.middleware("http")
    async def private(request, call_next):
        if request.headers.get("host") != f"127.0.0.1:{options.port}" or request.headers.get("origin"):
            return Response(status_code=403)
        if not secrets.compare_digest(request.headers.get("authorization", "").encode(), ("Bearer " + options.capability).encode()):
            return Response(status_code=401)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(ValueError)
    async def invalid(_request, _error):
        return JSONResponse({"detail": "The speech input is invalid or exceeds its supported bounds."}, status_code=400)

    @app.exception_handler(Exception)
    async def failed(_request, _error):
        return JSONResponse({"detail": "Local speech inference failed."}, status_code=503)

    def require(name):
        current = app.state.engines
        if getattr(current, name) is None:
            raise HTTPException(503, current.reasons[name])
        return current

    @app.get("/health")
    async def health():
        current = app.state.engines
        return {"ok": True, "version": "pipecat-1.15.0/arke-1", "protocolVersion": 1,
                "architecture": architecture,
                "engines": ["kokoro", "whisper"],
                "engineStatus": {name: {"ready": getattr(current, name) is not None,
                    **({"reason": current.reasons[name]} if getattr(current, name) is None else {})}
                    for name in ("kokoro", "whisper")},
                "wordTiming": {"ready": False, "reason": "Measured word timing has not been qualified for this runtime."}}

    @app.get("/voices")
    async def voices():
        return app.state.engines.voices()

    @app.post("/tts")
    async def synthesize(request: Request):
        if request.headers.get("content-type", "").split(";")[0] != "application/json":
            raise HTTPException(415, "Local synthesis requires JSON.")
        try:
            data = Synthesis.model_validate_json(await read_body(request, 32 * 1024))
        except ValueError:
            raise HTTPException(400, "Invalid local synthesis request.") from None
        current = require("kokoro")
        audio = await lane.run(request, current.synthesize, data.text, data.voice, data.speed)
        return Response(audio, media_type="audio/wav")

    @app.post("/stt")
    async def transcribe(request: Request):
        content_type = request.headers.get("content-type", "").lower()
        if not content_type.startswith("audio/") and content_type.split(";")[0] != "application/octet-stream":
            raise HTTPException(415, "Local recognition requires audio.")
        prompt = recognition_hint(request)
        data = await read_body(request, MAX_AUDIO_BYTES)
        if not data:
            raise HTTPException(400, "The recording is empty.")
        current = require("whisper")
        return {"text": await lane.run(request, current.transcribe, data, prompt, content_type)}

    return app


if __name__ == "__main__":
    import uvicorn
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--kokoro", type=Path, required=True)
    parser.add_argument("--whisper", type=Path, required=True)
    parser.add_argument("--espeak", type=Path, required=True)
    options = parser.parse_args()
    options.capability = os.environ.get("ARKE_SPEECH_CAPABILITY", "")
    if not 1 <= options.port <= 65535:
        parser.error("A private loopback port is required.")
    # Access/error logs must never copy request headers, transcript or filesystem paths.
    uvicorn.run(create_app(options), host="127.0.0.1", port=options.port, access_log=False, log_level="critical")
