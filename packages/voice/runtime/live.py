"""Private audio pipeline. Studio alone owns model sessions, tools and history."""
import asyncio
import base64
from dataclasses import fields
from datetime import datetime, timezone
import io
import json
import secrets
import time
import uuid
import wave

from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (BotStartedSpeakingFrame, BotStoppedSpeakingFrame,
    InputAudioRawFrame, InterruptionFrame, LLMContextFrame, LLMFullResponseEndFrame,
    LLMFullResponseStartFrame, LLMTextFrame, OutputAudioRawFrame, TranscriptionFrame,
    TTSAudioRawFrame, UserStartedSpeakingFrame, UserStoppedSpeakingFrame, VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame)
from pipecat.observers.base_observer import BaseObserver
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker, ProcessorUnusablePolicy
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.processors.frame_processor import FrameDirection
from pipecat.serializers.base_serializer import FrameSerializer
from pipecat.services.llm_service import LLMService
from pipecat.services.settings import LLMSettings, STTSettings, TTSSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.services.tts_service import TTSService
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport
from pipecat.workers.runner import WorkerRunner

# Pipecat's default diagnostic sink can print frame/transcript data. The host has
# sanitized health/exit diagnostics; no audio-pipeline logger owns a transcript.
logger.remove()


class LivePeer:
    def __init__(self, socket):
        self.socket, self.closed = socket, False
        self.send_gate = asyncio.Lock()
        self.turn, self.pending = None, None
        self.frames, self.window = 0, time.monotonic()
        self.audio_bytes, self.speaking = 0, False

    async def emit(self, kind, **payload):
        if self.closed:
            return
        async with self.send_gate:
            await self.socket.send_text(json.dumps({"type": kind, **payload}))

    async def disconnect(self):
        self.closed = True
        if self.pending:
            while not self.pending.empty():
                self.pending.get_nowait()
            self.pending.put_nowait(None)

    def receive(self, message):
        if not isinstance(message, dict):
            raise ValueError("Invalid live frame")
        kind = message.get("type")
        if kind == "interrupt":
            return InterruptionFrame()
        if kind in ("delta", "done", "failed"):
            if message.get("turn") != self.turn or not self.pending:
                return None  # a stopped inference cannot speak into a later turn
            if kind == "delta":
                text = message.get("text")
                if not isinstance(text, str) or not text or len(text) > 2048:
                    raise ValueError("Invalid conversational delta")
                if self.pending.full():
                    raise ValueError("Conversational output exceeds its bound")
                self.pending.put_nowait(text)
            else:
                if self.pending.full():
                    raise ValueError("Conversational output exceeds its bound")
                self.pending.put_nowait(None)
            return None
        if kind != "audio":
            raise ValueError("Unknown live frame")
        encoded = message.get("audio")
        if not isinstance(encoded, str) or len(encoded) > 16384:
            raise ValueError("Invalid audio frame")
        pcm = base64.b64decode(encoded, validate=True)
        if not pcm or len(pcm) % 2 or len(pcm) > 8192:
            raise ValueError("Invalid PCM frame")
        now = time.monotonic()
        if now - self.window >= 1:
            self.frames, self.window = 0, now
        self.frames += 1
        self.audio_bytes = self.audio_bytes + len(pcm) if self.speaking else 0
        if self.frames > 120 or self.audio_bytes > 16000 * 2 * 60:
            raise ValueError("Audio admission exceeded its bound")
        return InputAudioRawFrame(pcm, 16000, 1)


class LiveSerializer(FrameSerializer):
    def __init__(self, peer):
        super().__init__()
        self.peer = peer

    async def serialize(self, frame):
        if isinstance(frame, OutputAudioRawFrame):
            # Send through the same gate as turn/state messages, preventing
            # interleaved ASGI sends. Transport pacing retains its own clock.
            await self.peer.emit("audio", audio=base64.b64encode(frame.audio).decode("ascii"))
        elif isinstance(frame, InterruptionFrame):
            await self.peer.emit("interrupted")
        return None

    async def deserialize(self, data):
        if not isinstance(data, str) or len(data) > 20000:
            raise ValueError("Invalid live message")
        return self.peer.receive(json.loads(data))


class SharedSTT(SegmentedSTTService):
    @property
    def wants_wav_segments(self):
        return False

    def __init__(self, owner):
        super().__init__(sample_rate=16000, settings=STTSettings(model="faster-whisper-base.en", language="en"))
        self.owner = owner

    async def run_stt(self, audio):
        if len(audio) > 16000 * 2 * 60:
            raise ValueError("Speech segment exceeds one minute")
        text = await self.owner.infer(self.owner.engines.transcribe, audio, None, "audio/pcm")
        if text.strip():
            yield TranscriptionFrame(text, "", datetime.now(timezone.utc).isoformat())


class SharedTTS(TTSService):
    def __init__(self, owner, voice):
        super().__init__(sample_rate=24000, settings=TTSSettings(model="kokoro-82m", voice=voice, language="en"))
        self.owner, self.voice = owner, voice

    async def run_tts(self, text, context_id):
        if len(text) > 4000:
            raise ValueError("Speech text exceeds its bound")
        wav = await self.owner.infer(self.owner.engines.synthesize, text, self.voice, 1)
        with wave.open(io.BytesIO(wav), "rb") as reader:
            pcm = reader.readframes(reader.getnframes())
        for start in range(0, len(pcm), 960):
            yield TTSAudioRawFrame(pcm[start:start + 960], 24000, 1, context_id=context_id)


class HostLLM(LLMService):
    def __init__(self, peer):
        settings = {field.name: None for field in fields(LLMSettings)}
        settings.update(model="studio-owned", system_instruction=None, use_provider_thinking_default=False)
        super().__init__(settings=LLMSettings(**settings))
        self.peer = peer

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if not isinstance(frame, LLMContextFrame):
            await self.push_frame(frame, direction)
            return
        messages = frame.context.messages
        if not messages or messages[-1].get("role") != "user":
            return
        text = messages[-1].get("content")
        if not isinstance(text, str) or not text.strip() or len(text) > 8000:
            raise ValueError("Invalid recognized turn")
        turn, queue = str(uuid.uuid4()), asyncio.Queue(maxsize=128)
        self.peer.turn, self.peer.pending = turn, queue
        await self.push_frame(LLMFullResponseStartFrame())
        try:
            await self.peer.emit("turn", turn=turn, text=text)
            size = 0
            async with asyncio.timeout(90):
                while not self.peer.closed:
                    delta = await queue.get()
                    if delta is None:
                        break
                    size += len(delta)
                    if size > 8000:
                        raise ValueError("Conversational reply exceeds its bound")
                    await self.push_frame(LLMTextFrame(delta))
        finally:
            # Interrupting speech interrupts this inference, never a Studio job.
            await self.peer.emit("turn-ended", turn=turn)
            if self.peer.turn == turn:
                self.peer.turn, self.peer.pending = None, None
            await self.push_frame(LLMFullResponseEndFrame())


class LiveObserver(BaseObserver):
    def __init__(self, peer):
        super().__init__()
        self.peer, self.seen = peer, set()

    async def on_push_frame(self, data):
        frame = data.frame
        if frame.id in self.seen:
            return
        self.seen.add(frame.id)
        if len(self.seen) > 4096:
            self.seen = {frame.id}
        if isinstance(frame, VADUserStartedSpeakingFrame):
            self.peer.speaking, self.peer.audio_bytes = True, 0
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            self.peer.speaking, self.peer.audio_bytes = False, 0
        if isinstance(frame, UserStartedSpeakingFrame):
            await self.peer.emit("state", state="listening")
        elif isinstance(frame, UserStoppedSpeakingFrame):
            self.peer.audio_bytes = 0
            await self.peer.emit("state", state="thinking")
        elif isinstance(frame, BotStartedSpeakingFrame):
            await self.peer.emit("state", state="speaking")
        elif isinstance(frame, BotStoppedSpeakingFrame):
            await self.peer.emit("state", state="listening")


async def serve_live(socket, engines, lane, options):
    """Only a host-authenticated socket may acquire the single live reservation."""
    if socket.headers.get("host") != f"127.0.0.1:{options.port}" or socket.headers.get("origin") or not secrets.compare_digest(
            socket.headers.get("authorization", "").encode(), ("Bearer " + options.capability).encode()):
        await socket.close(code=1008)
        return
    await socket.accept()
    peer = LivePeer(socket)
    class Owner:
        async def is_disconnected(self):
            return peer.closed
        async def infer(self, function, *args):
            return await lane.run(self, function, *args)
    owner = Owner()
    owner.engines = engines
    runner = None
    try:
        async with asyncio.timeout(10):
            config = await socket.receive_json()
        voice, silence = config.get("voice"), config.get("silenceMs")
        if voice not in {item["id"] for item in engines.voices()} or not isinstance(silence, int) or not 400 <= silence <= 2000:
            raise ValueError("Invalid live configuration")
        if engines.whisper is None or engines.kokoro is None:
            raise ValueError("Local speech is unavailable")
        transport = FastAPIWebsocketTransport(socket, FastAPIWebsocketParams(audio_in_enabled=True, audio_out_enabled=True,
            serializer=LiveSerializer(peer), allowed_origins=[], session_timeout=1200))
        user, assistant = LLMContextAggregatorPair(LLMContext(), user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=silence / 1000))))
        worker = PipelineWorker(Pipeline([transport.input(), SharedSTT(owner), user, HostLLM(peer), SharedTTS(owner, voice),
            transport.output(), assistant]), params=PipelineParams(audio_in_sample_rate=16000, audio_out_sample_rate=24000),
            observers=[LiveObserver(peer)], idle_timeout_secs=1200, processor_unusable_policy=ProcessorUnusablePolicy.END)
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)
        @transport.event_handler("on_client_disconnected")
        async def disconnected(*_):
            await peer.disconnect()
            await runner.cancel()
        @transport.event_handler("on_session_timeout")
        async def timed_out(*_):
            await peer.disconnect()
            await runner.cancel()
        await peer.emit("ready")
        async with asyncio.timeout(1200):
            await runner.run()
    except Exception:
        if not peer.closed:
            await peer.emit("failed")
    finally:
        await peer.disconnect()
        if runner:
            await runner.cancel()
        await socket.close()
