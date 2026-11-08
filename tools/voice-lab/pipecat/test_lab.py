import asyncio
from pathlib import Path

import pytest
import aiohttp

from opencode_bridge import OpenCode, sse_events
from app import LabSession


async def lines(values):
    for value in values:
        yield value


async def test_sse_handles_comments_multiline_and_frame_limit():
    events = [event async for event in sse_events(lines([
        b": heartbeat\n", b"\n", b'data: {"type":\n', b'data: "session.text.delta"}\n', b"\n",
    ]))]
    assert events == [{"type": "session.text.delta"}]
    with pytest.raises(RuntimeError, match="limit"):
        _ = [event async for event in sse_events(lines([b"x" * (4 * 1024 * 1024 + 1)]))]


async def test_stream_owns_dispatch_and_cancels_without_replay():
    engine = OpenCode(Path("unused"), Path("unused"))
    engine.sessions.add("owned")
    calls = []
    async def request(method, path, body=None):
        calls.append((method, path))
        if path.endswith("prompt"):
            engine.queues["owned"].put_nowait({"type": "session.text.delta", "data": {"delta": "hello"}})
    engine.request = request
    stream = engine.stream("owned", "one prompt")
    assert await anext(stream) == "hello"
    await stream.aclose()
    assert calls == [("POST", "/api/session/owned/prompt"), ("POST", "/api/session/owned/interrupt")]
    assert not engine.queues
    with pytest.raises(RuntimeError, match="Invalid"):
        await anext(engine.stream("someone-else", "must not dispatch"))


async def test_completed_turn_does_not_cancel_or_replay():
    engine = OpenCode(Path("unused"), Path("unused"))
    engine.sessions.add("owned")
    calls = []
    async def request(method, path, body=None):
        calls.append(path)
        engine.queues["owned"].put_nowait({"type": "session.execution.succeeded", "data": {}})
    engine.request = request
    assert [part async for part in engine.stream("owned", "hello")] == []
    assert calls == ["/api/session/owned/prompt"]


async def test_background_result_waits_for_pending_user_transcription():
    class Worker:
        def __init__(self):
            self.frames = []
        async def queue_frames(self, frames):
            self.frames.extend(frames)
    session = LabSession(None, "provider/model", "bf_emma", 0)
    session.worker = Worker()
    session.pending.append("background answer")
    session.awaiting_transcript = True
    await session.deliver_pending()
    assert not session.worker.frames
    assert len(session.pending) == 1
    session.awaiting_transcript = False
    await session.deliver_pending()
    assert len(session.worker.frames) == 1
    assert not session.pending
    assert session.busy


async def test_admitted_text_cannot_be_overwritten_by_a_second_request():
    class Worker:
        async def queue_frames(self, frames):
            pass
    session = LabSession(None, "provider/model", "bf_emma", 0)
    session.worker = Worker()
    await session.text("first")
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as failure:
        await session.text("second")
    assert failure.value.status_code == 409
    assert session.context.messages[-1]["content"] == "first"


async def test_api_requires_cookie_and_rejects_foreign_origin_and_host(tmp_path):
    from argparse import Namespace
    import uvicorn
    from app import create_app, COOKIE
    from opencode_bridge import free_port
    port = free_port()
    app = create_app(Namespace(port=port, state=tmp_path, opencode=tmp_path / "unused", model="provider/model"))
    lab = app.state.lab
    lab.models = ["provider/model"]
    class Speech:
        def voice_names(self):
            return ["bf_emma"]
    lab.kokoro = Speech()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, lifespan="off", log_level="critical"))
    task = asyncio.create_task(server.serve())
    try:
        async with asyncio.timeout(5):
            while not server.started:
                await asyncio.sleep(.01)
        async with aiohttp.ClientSession() as client:
            url = f"http://127.0.0.1:{port}/api/config"
            async with client.get(url) as response:
                assert response.status == 401
            headers = {"Cookie": f"{COOKIE}={lab.cookie}"}
            async with client.get(url, headers=headers) as response:
                assert response.status == 200
            async with client.get(url, headers={**headers, "Origin": "https://another-site.example"}) as response:
                assert response.status == 403
            async with client.get(url, headers={**headers, "Host": f"other-host.example:{port}"}) as response:
                assert response.status == 403
            async with client.delete(f"http://127.0.0.1:{port}/api/session/not-owned", headers=headers) as response:
                assert response.status == 404
    finally:
        server.should_exit = True
        await task


async def test_cancelled_speech_keeps_native_lock_until_inference_exits():
    import threading
    from speech import KokoroEngine
    engine = KokoroEngine.__new__(KokoroEngine)
    engine.gate, engine.work = asyncio.Lock(), set()
    started, release = threading.Event(), threading.Event()
    def synthesize(text, voice):
        started.set()
        release.wait(5)
        return b"audio"
    engine.synthesize = synthesize
    call = asyncio.create_task(engine.synthesize_async("test", "voice"))
    try:
        await asyncio.wait_for(asyncio.to_thread(started.wait), 2)
        call.cancel()
        with pytest.raises(asyncio.CancelledError):
            await call
        assert engine.gate.locked()
        assert engine.work
    finally:
        release.set()
        await engine.close()
    assert not engine.gate.locked()
    assert not engine.work
