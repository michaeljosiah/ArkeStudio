"""An isolated Pipecat / Kokoro / OpenCode audition, not a Studio voice route."""
import argparse
import asyncio
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import fields
import io
import json
import os
from pathlib import Path
import secrets
import time
import wave

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    BotStartedSpeakingFrame, BotStoppedSpeakingFrame, Frame, InterruptionFrame,
    LLMContextFrame, LLMFullResponseEndFrame, LLMFullResponseStartFrame,
    LLMRunFrame, LLMTextFrame, TranscriptionFrame,
    UserStartedSpeakingFrame, UserStoppedSpeakingFrame, VADUserStoppedSpeakingFrame,
)
from pipecat.observers.base_observer import BaseObserver
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker, ProcessorUnusablePolicy
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.llm_service import LLMService
from pipecat.services.settings import LLMSettings
from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.request_handler import SmallWebRTCRequest, SmallWebRTCRequestHandler, SmallWebRTCPatchRequest, IceCandidate
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner

from opencode_bridge import OpenCode
from speech import KokoroEngine
from speech import LocalKokoroTTS
from reference_library import search_reference_library

ROOT = Path(__file__).resolve().parent
COOKIE = "arke_voice_lab"
TALKER_PROMPT = """You are Arke's voice experiment companion. Speak naturally in one or two short sentences.
Your words are spoken aloud. Avoid markdown, lists, emojis, and stage directions. Answer the latest request.
You have no access to Arke worlds or files. For a request to work in the background, call
voice-lab_start_background_task. Acknowledge its receipt promptly, then continue talking normally.
The tool returns immediately; do not wait or repeatedly poll. Its result will arrive in a later message.
Do not invent results. If asked about progress, use voice-lab_background_status.
A background tool may be deliberately delayed for this experiment; don't claim you have its answer yet.
For a reference-library request, delegate it; only the background worker can search those notes."""
WORKER_PROMPT = """You are a background worker in a voice test. Your read-only tool is
voice-lab_search_reference_library. Use it before answering, with the job_id supplied in your request.
Search the fictional sample library for the subject of the user's task. Answer from the returned
notes in at most three short sentences. Name the source note. Do not invent missing library facts.
You have no access to Arke worlds, arbitrary files, browsing, or write tools.
The reference tool may take time to return; wait for its real result instead of simulating it."""


class OpenCodeLLM(LLMService):
    def __init__(self, session):
        settings = {field.name: None for field in fields(LLMSettings)}
        settings.update(model=session.model, system_instruction=None, use_provider_thinking_default=False)
        super().__init__(settings=LLMSettings(**settings))
        self.lab = session
        self.last_user_message = None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if not isinstance(frame, LLMContextFrame):
            await self.push_frame(frame, direction)
            return
        messages = frame.context.messages
        if not messages:
            return
        last = messages[-1]
        text = last.get("content", "")
        if not isinstance(text, str) or not text.strip():
            return
        if last.get("role") not in ("user", "developer"):
            return
        self.lab.busy = True
        self.lab.awaiting_transcript = False
        await self.push_frame(LLMFullResponseStartFrame())
        started, first = time.perf_counter(), True
        try:
            async def tool(name):
                await self.lab.emit("tool", {"name": name})
            async for delta in self.lab.owner.opencode.stream(self.lab.native_id, text, tool):
                if first:
                    await self.lab.emit("first-token", {"ms": round((time.perf_counter() - started) * 1000)})
                    first = False
                await self.lab.emit("assistant-delta", {"text": delta})
                await self.push_frame(LLMTextFrame(delta))
            await self.lab.emit("assistant-end", {})
        except asyncio.CancelledError:
            await self.lab.emit("interrupted", {})
            raise
        except Exception as error:
            await self.lab.emit("error", {"message": str(error)[:240]})
        finally:
            self.lab.busy = False
            await self.push_frame(LLMFullResponseEndFrame())
            await self.lab.deliver_pending()


class LabObserver(BaseObserver):
    def __init__(self, lab):
        super().__init__()
        self.lab, self.seen = lab, deque(maxlen=2048)
        self.bot_speaking = False
        self.last_interruption = 0

    async def on_push_frame(self, data):
        frame = data.frame
        if frame.id in self.seen:
            return
        self.seen.append(frame.id)
        if isinstance(frame, UserStartedSpeakingFrame):
            if self.lab.speaking:
                return
            self.lab.speaking = True
            self.lab.awaiting_transcript = True
            await self.lab.emit("user-speaking", {"active": True})
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            self.lab.last_stop = time.perf_counter()
            await self.lab.emit("speech-ended", {})
        elif isinstance(frame, UserStoppedSpeakingFrame):
            if not self.lab.speaking:
                return
            self.lab.speaking = False
            await self.lab.emit("user-speaking", {"active": False})
        elif isinstance(frame, TranscriptionFrame):
            await self.lab.emit("transcript", {"text": frame.text})
        elif isinstance(frame, BotStartedSpeakingFrame):
            if self.bot_speaking:
                return
            self.bot_speaking = True
            latency = round((time.perf_counter() - self.lab.last_stop) * 1000) if self.lab.last_stop else None
            await self.lab.emit("bot-speaking", {"active": True, "latencyMs": latency})
        elif isinstance(frame, BotStoppedSpeakingFrame):
            if not self.bot_speaking:
                return
            self.bot_speaking = False
            await self.lab.emit("bot-speaking", {"active": False})
        elif isinstance(frame, InterruptionFrame):
            if time.perf_counter() - self.last_interruption < .1:
                return
            self.last_interruption = time.perf_counter()
            await self.lab.emit("interrupted", {})


class LabSession:
    def __init__(self, owner, model, voice, delay):
        self.owner, self.model, self.voice, self.delay = owner, model, voice, delay
        self.id = secrets.token_urlsafe(18)
        self.native_id = None
        self.context = LLMContext()
        self.worker = self.runner = self.task = None
        self.jobs, self.pending, self.listeners = {}, deque(), set()
        self.busy = self.speaking = self.closed = False
        self.awaiting_transcript = False
        self.last_stop = None
        self.events = deque(maxlen=500)

    async def emit(self, kind, payload):
        event = {"type": kind, "at": round(time.time() * 1000), **payload}
        self.events.append(event)
        for queue in self.listeners.copy():
            if queue.full():
                self.listeners.discard(queue)
            else:
                queue.put_nowait(event)

    async def connect(self, connection):
        if self.worker or self.closed:
            raise RuntimeError("This test session has already connected")
        transport = SmallWebRTCTransport(connection, TransportParams(audio_in_enabled=True, audio_out_enabled=True))
        stt = WhisperSTTService(settings=WhisperSTTService.Settings(model=str(self.owner.whisper_path)), device="cpu", compute_type="int8")
        user, assistant = LLMContextAggregatorPair(self.context, user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=.65)),
        ))
        llm = OpenCodeLLM(self)
        tts = LocalKokoroTTS(self.owner.kokoro, self.voice, self.emit)
        pipeline = Pipeline([transport.input(), stt, user, llm, tts, transport.output(), assistant])
        self.worker = PipelineWorker(pipeline, params=PipelineParams(audio_in_sample_rate=16000, audio_out_sample_rate=24000,
                                       enable_metrics=True), observers=[LabObserver(self)],
                                     idle_timeout_secs=300, processor_unusable_policy=ProcessorUnusablePolicy.END)
        self.runner = WorkerRunner(handle_sigint=False)
        await self.runner.add_workers(self.worker)

        @transport.event_handler("on_client_disconnected")
        async def disconnected(*_):
            await self.emit("disconnected", {})
            await self.runner.cancel()

        self.task = asyncio.create_task(self.runner.run())
        await self.emit("connected", {"model": self.model, "voice": self.voice})

    async def text(self, text):
        if not self.worker or self.closed:
            raise HTTPException(409, "Connect the voice session first")
        if self.busy or self.speaking:
            raise HTTPException(409, "Wait for the current turn, or interrupt by speaking")
        self.context.add_message({"role": "user", "content": text})
        self.busy = True
        await self.emit("transcript", {"text": text, "typed": True})
        await self.worker.queue_frames([LLMRunFrame()])

    async def start_job(self, task):
        if len([job for job in self.jobs.values() if job["status"] == "running"]) >= 2:
            raise ValueError("Two background tasks are already running")
        jid = secrets.token_hex(4)
        job = {"id": jid, "task": task, "status": "running"}
        self.jobs[jid] = job
        await self.emit("background-start", {"id": jid, "task": task, "delaySeconds": self.delay})
        job["handle"] = asyncio.create_task(self.run_job(job))
        return {"id": jid, "status": "running", "message": "Accepted. Continue the conversation; the result will arrive later."}

    async def run_job(self, job):
        sid = None
        try:
            sid = await self.owner.opencode.create(self.model, "voice-lab-worker")
            prompt = f"{job['task']}\n\nThis task's job_id is {job['id']}. Use it when calling search_reference_library."
            chunks = [text async for text in self.owner.opencode.stream(sid, prompt)]
            job.update(status="complete", result="".join(chunks))
            await self.emit("background-complete", {"id": job["id"], "text": job["result"]})
            self.pending.append(f"Background task {job['id']} completed. Task: {job['task']}\nResult: {job['result']}\nTell the user briefly, without inventing anything.")
            await self.deliver_pending()
        except asyncio.CancelledError:
            job["status"] = "cancelled"
            raise
        except Exception:
            job.update(status="failed")
            await self.emit("background-failed", {"id": job["id"]})
        finally:
            if sid:
                await self.owner.opencode.retire(sid)

    async def search_reference(self, job_id, query):
        job = self.jobs.get(job_id) if isinstance(job_id, str) else None
        if not job or job["status"] != "running" or self.closed:
            raise ValueError("This background task is no longer running")
        if not isinstance(query, str) or not query.strip() or len(query) > 250:
            raise ValueError("Search query must contain 1–250 characters")
        calls = job.setdefault("toolCalls", [])
        if len(calls) >= 4:
            raise ValueError("The task's four-search limit has been reached")
        call = {"name": "search_reference_library", "query": query, "status": "running"}
        calls.append(call)
        await self.emit("background-tool-start", {"id": job_id, "name": call["name"], "query": query, "delaySeconds": self.delay})
        # The visible hold is inside the actual tool call, so the test can prove
        # conversation proceeds while the background OpenCode agent awaits a tool.
        await asyncio.sleep(self.delay)
        if self.closed or job["status"] != "running":
            raise ValueError("The background task ended before its search returned")
        result = await asyncio.to_thread(search_reference_library, query)
        call.update(status="complete", sources=[match["id"] for match in result["matches"]])
        await self.emit("background-tool-result", {"id": job_id, "name": call["name"], "sources": call["sources"]})
        return result

    async def deliver_pending(self):
        if self.pending and self.worker and not self.closed and not self.busy and not self.speaking and not self.awaiting_transcript:
            self.busy = True
            self.context.add_message({"role": "developer", "content": self.pending.popleft()})
            await self.worker.queue_frames([LLMRunFrame()])

    async def close(self):
        self.closed = True
        handles = [job["handle"] for job in self.jobs.values()]
        for handle in handles:
            handle.cancel()
        await asyncio.gather(*handles, return_exceptions=True)
        if self.runner:
            await self.runner.cancel()
        if self.task:
            await asyncio.gather(self.task, return_exceptions=True)
        if self.native_id:
            await self.owner.opencode.retire(self.native_id)


class Lab:
    def __init__(self, options):
        self.options = options
        self.cookie, self.mcp_secret = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        self.current = None
        self.handler = SmallWebRTCRequestHandler(ice_servers=[])
        self.opencode = OpenCode(options.opencode, options.state / "sandbox")
        self.kokoro = None
        self.whisper_path = None
        self.models = []
        self.session_gate = asyncio.Lock()

    async def connect_tools(self):
        from urllib.parse import quote
        suffix = "?location%5Bdirectory%5D=" + quote(self.opencode.sandbox.as_posix(), safe="")
        await self.opencode.request("POST", "/api/experimental/mcp/voice-lab/connect" + suffix, {})
        for _ in range(30):
            rows = await self.opencode.request("GET", "/api/mcp" + suffix)
            if any(row.get("name") == "voice-lab" and row.get("status", {}).get("status") == "connected" for row in rows):
                return
            await asyncio.sleep(.1)
        raise HTTPException(503, "OpenCode could not connect to the background test tools")

    async def start(self):
        sandbox = self.opencode.sandbox
        sandbox.mkdir(parents=True, exist_ok=True)
        config = {
            "$schema": "https://opencode.ai/config.json", "default_agent": "voice-lab",
            "agents": {"voice-lab": {"system": TALKER_PROMPT}, "voice-lab-worker": {"system": WORKER_PROMPT}},
            "permissions": [{"action": "*", "resource": "*", "effect": "deny"}],
            "policies": [
                {"action": "mcp.use", "resource": "*", "effect": "deny"},
                {"action": "mcp.use", "resource": "voice-lab", "effect": "allow"},
                {"action": "skill.use", "resource": "*", "effect": "deny"},
                {"action": "plugin.use", "resource": "*", "effect": "deny"},
            ],
            "compaction": {"auto": False}, "warming": False, "websearch": False,
            "mcp": {"servers": {"voice-lab": {"type": "remote", "codemode": False,
                    "url": f"http://127.0.0.1:{self.options.port}/mcp/{self.mcp_secret}"}}},
        }
        (sandbox / "opencode.json").write_text(json.dumps(config), encoding="utf-8")
        await self.opencode.start()
        models = await self.opencode.request("GET", "/api/model?location%5Bdirectory%5D=" + __import__("urllib.parse", fromlist=["quote"]).quote(sandbox.as_posix(), safe=""))
        self.models = sorted({f"{m['providerID']}/{m['id']}" for m in models if m.get("providerID") not in ("ollama", "lmstudio")})
        self.kokoro = await asyncio.to_thread(KokoroEngine, self.options.kokoro / "model_quantized.onnx", self.options.kokoro / "voices", self.options.espeak)
        from faster_whisper import download_model
        self.whisper_path = Path(await asyncio.to_thread(download_model, "base.en", cache_dir=str(self.options.state / "models")))
        # Warm native inference once; the page still reports cold OpenCode turns separately.
        await asyncio.to_thread(self.kokoro.synthesize, "Ready.", "bf_emma")

    async def close(self):
        try:
            if self.current:
                await self.current.close()
            await self.handler.close()
        finally:
            await self.opencode.close()
            if self.kokoro:
                await self.kokoro.close()
            # The ephemeral MCP capability must not remain in an abandoned lab config.
            (self.opencode.sandbox / "opencode.json").unlink(missing_ok=True)


def create_app(options):
    lab = Lab(options)

    @asynccontextmanager
    async def lifespan(app):
        try:
            await lab.start()
            logger.info("Voice lab ready at http://127.0.0.1:{}", options.port)
            yield
        finally:
            await lab.close()

    app = FastAPI(lifespan=lifespan)
    app.state.lab = lab

    @app.middleware("http")
    async def local_only(request, call_next):
        expected = f"127.0.0.1:{options.port}"
        if request.headers.get("host") != expected:
            return Response(status_code=403)
        if request.url.path.startswith("/api/"):
            origin = request.headers.get("origin")
            if origin and origin != f"http://{expected}":
                return Response(status_code=403)
            if request.cookies.get(COOKIE) != lab.cookie:
                return Response(status_code=401)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.exception_handler(RuntimeError)
    async def runtime_error(_request, error):
        return JSONResponse({"detail": str(error)[:240]}, status_code=503)

    def session(sid):
        if not lab.current or lab.current.id != sid or lab.current.closed:
            raise HTTPException(404, "Test session ended")
        return lab.current

    @app.get("/")
    async def index():
        response = FileResponse(ROOT / "web" / "dist" / "index.html")
        response.set_cookie(COOKIE, lab.cookie, httponly=True, samesite="strict")
        return response

    @app.get("/api/config")
    async def config():
        return {"models": lab.models, "voices": lab.kokoro.voice_names(), "defaultModel": options.model,
                "defaultVoice": "bf_emma", "pipecat": "1.15.0", "opencode": "2.2.5", "recognizer": "Whisper base.en / CPU int8",
                "kokoro": "Kokoro 82M quantized / CPU", "speechLocal": True}

    @app.post("/api/session")
    async def begin(request: Request):
        data = await request.json()
        model, voice = data.get("model"), data.get("voice")
        if model not in lab.models or voice not in lab.kokoro.voice_names():
            raise HTTPException(400, "Select an available model and voice")
        async with lab.session_gate:
            if lab.current and not lab.current.closed:
                raise HTTPException(409, "End the current test session first")
            await lab.connect_tools()
            current = LabSession(lab, model, voice, max(0, min(30, float(data.get("delay", 10)))))
            current.native_id = await lab.opencode.create(model)
            lab.current = current
            return {"id": current.id}

    @app.get("/api/diagnostics")
    async def diagnostics():
        from urllib.parse import quote
        suffix = "?location%5Bdirectory%5D=" + quote(lab.opencode.sandbox.as_posix(), safe="")
        mcp = await lab.opencode.request("GET", "/api/mcp" + suffix)
        current = lab.current
        rows = mcp if isinstance(mcp, list) else [mcp]
        safe_mcp = [{"name": row.get("name"), "status": row.get("status", {}).get("status")} for row in rows]
        return {"mcp": safe_mcp, "session": current.id if current else None,
                "events": list(current.events) if current else []}

    @app.post("/api/offer/{sid}")
    async def offer(sid: str, request: Request):
        current = session(sid)
        return await lab.handler.handle_web_request(SmallWebRTCRequest.from_dict(await request.json()), current.connect)

    @app.patch("/api/offer/{sid}")
    async def patch(sid: str, request: Request):
        session(sid)
        data = await request.json()
        await lab.handler.handle_patch_request(SmallWebRTCPatchRequest(pc_id=data["pc_id"], candidates=[IceCandidate(**candidate) for candidate in data["candidates"]]))
        return {"ok": True}

    @app.get("/api/events/{sid}")
    async def events(sid: str):
        current = session(sid)
        async def stream():
            queue = asyncio.Queue(maxsize=256)
            current.listeners.add(queue)
            try:
                for event in list(current.events):
                    yield "data: " + json.dumps(event) + "\n\n"
                while not current.closed:
                    try:
                        event = await asyncio.wait_for(queue.get(), 10)
                        yield "data: " + json.dumps(event) + "\n\n"
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
            finally:
                current.listeners.discard(queue)
        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.post("/api/text/{sid}")
    async def text(sid: str, request: Request):
        value = (await request.json()).get("text", "")
        if not isinstance(value, str) or not value.strip() or len(value) > 4000:
            raise HTTPException(400, "Enter 1–4000 characters")
        await session(sid).text(value)
        return {"accepted": True}

    @app.delete("/api/session/{sid}")
    async def end(sid: str):
        await session(sid).close()
        await lab.handler.close()
        return {"ended": True}

    @app.post("/api/shutdown")
    async def shutdown():
        server = getattr(app.state, "server", None)
        if server is None:
            raise HTTPException(503, "No owned test server is available")
        if lab.current and not lab.current.closed:
            await lab.current.close()
        await lab.handler.close()
        server.should_exit = True
        return {"stopping": True}

    @app.post("/api/audition")
    async def audition(request: Request):
        voice = (await request.json()).get("voice", "bf_emma")
        pcm = await lab.kokoro.synthesize_async("Hello. This is the local Kokoro voice, ready for a conversation.", voice)
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(24000)
            wav.writeframes(pcm)
        return Response(output.getvalue(), media_type="audio/wav")

    @app.post("/mcp/{capability}")
    async def mcp(capability: str, request: Request):
        if not secrets.compare_digest(capability, lab.mcp_secret):
            raise HTTPException(404)
        body = await request.json()
        if "id" not in body:
            return Response(status_code=202)
        method, params = body.get("method"), body.get("params", {})
        if method == "initialize":
            result = {"protocolVersion": params.get("protocolVersion", "2025-03-26"), "capabilities": {"tools": {}},
                      "serverInfo": {"name": "arke-voice-lab", "version": "0.1.0"}}
        elif method == "tools/list":
            result = {"tools": [
                {"name": "start_background_task", "description": "Delegate a knowledge question to a background cloud agent. Returns immediately; conversation can continue. Completion is delivered later.",
                 "inputSchema": {"type": "object", "properties": {"task": {"type": "string", "maxLength": 2000}}, "required": ["task"], "additionalProperties": False}},
                {"name": "background_status", "description": "Check the current background task status, without waiting.", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
                {"name": "search_reference_library", "description": "Read-only search of the fictional Skyharbour reference notes. Only available to background workers. Returns source note titles and text; no access to real worlds or arbitrary paths.",
                 "inputSchema": {"type": "object", "properties": {"query": {"type": "string", "maxLength": 250}, "job_id": {"type": "string", "pattern": "^[a-f0-9]{8}$"}}, "required": ["query", "job_id"], "additionalProperties": False}},
            ]}
        elif method == "tools/call":
            current = lab.current
            if not current or current.closed:
                value = {"error": "No live voice test"}
            elif params.get("name") == "start_background_task":
                task = params.get("arguments", {}).get("task", "")
                try:
                    if not isinstance(task, str) or not task.strip() or len(task) > 2000:
                        raise ValueError("Task must contain 1–2000 characters")
                    value = await current.start_job(task)
                except ValueError as error:
                    value = {"error": str(error)}
            elif params.get("name") == "background_status":
                value = [{key: value for key, value in job.items() if key != "handle"} for job in current.jobs.values()]
            elif params.get("name") == "search_reference_library":
                arguments = params.get("arguments", {})
                try:
                    value = await current.search_reference(arguments.get("job_id"), arguments.get("query"))
                except ValueError as error:
                    value = {"error": str(error)}
            else:
                value = {"error": "Unknown lab tool"}
            result = {"content": [{"type": "text", "text": json.dumps(value)}]}
        elif method == "ping":
            result = {}
        else:
            return JSONResponse({"jsonrpc": "2.0", "id": body["id"], "error": {"code": -32601, "message": "Method not found"}})
        return JSONResponse({"jsonrpc": "2.0", "id": body["id"], "result": result})

    app.mount("/assets", StaticFiles(directory=ROOT / "web" / "dist" / "assets", check_dir=False), name="assets")
    return app


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9075)
    parser.add_argument("--state", type=Path, default=ROOT / ".lab")
    parser.add_argument("--kokoro", type=Path, default=Path.home() / "ArkeStudio/models/kokoro-82m")
    resources = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs/Arke Studio/resources"
    parser.add_argument("--espeak", type=Path, default=resources / "espeak-ng/espeak-ng.exe")
    parser.add_argument("--opencode", type=Path, default=resources / "opencode2/opencode2.exe")
    parser.add_argument("--model", default="github-copilot/claude-haiku-4.5")
    return parser.parse_args()


if __name__ == "__main__":
    import uvicorn
    logger.remove()
    logger.add(__import__("sys").stderr, level="INFO")
    options = arguments()
    app = create_app(options)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=options.port, log_level="warning", access_log=False))
    app.state.server = server
    server.run()
