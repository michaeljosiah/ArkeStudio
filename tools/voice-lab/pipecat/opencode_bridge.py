"""The pinned OpenCode 2.2.5 HTTP/SSE protocol, kept outside Studio's adapters.

Owns only disposable lab sessions. Native credentials stay in OpenCode; its
launch password is held in memory and never sent to the test page.
"""
import asyncio
import json
import os
import socket
import uuid
from pathlib import Path

import aiohttp


def session_permissions(agent):
    tools = {
        "voice-lab": ("voice-lab_start_background_task", "voice-lab_background_status"),
        "voice-lab-worker": ("voice-lab_search_reference_library",),
    }
    if agent not in tools:
        raise ValueError("Unknown lab agent")
    return [{"action": "*", "resource": "*", "effect": "deny"},
            *({"action": tool, "resource": "*", "effect": "allow"} for tool in tools[agent])]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


async def sse_events(content):
    data = []
    size = 0
    async for line in content:
        size += len(line)
        if size > 4 * 1024 * 1024:
            raise RuntimeError("OpenCode event exceeded the lab limit")
        value = line.decode("utf-8").rstrip("\r\n")
        if not value:
            if data:
                yield json.loads("\n".join(data))
            data, size = [], 0
        elif value.startswith("data:"):
            data.append(value[5:].lstrip())


class OpenCode:
    def __init__(self, executable: Path, sandbox: Path):
        self.executable, self.sandbox = executable, sandbox
        self.process = None
        self.http = None
        self.events_task = None
        self.log_task = None
        self.queues = {}
        self.sessions = set()
        self.ready = asyncio.Event()

    async def start(self):
        version = await asyncio.create_subprocess_exec(str(self.executable), "--version", stdout=asyncio.subprocess.PIPE)
        stdout, _ = await version.communicate()
        if stdout.decode().strip() != "opencode v2.2.5":
            raise RuntimeError("This lab requires Arke's qualified OpenCode 2.2.5 binary")
        port = free_port()
        env = dict(os.environ)
        for key in list(env):
            if key.startswith(("OPENCODE_", "OTEL_")):
                del env[key]
        env.update(OPENCODE_DISABLE_AUTOUPDATE="1", DO_NOT_TRACK="1")
        self.process = await asyncio.create_subprocess_exec(
            str(self.executable), "serve", "--hostname", "127.0.0.1", "--port", str(port),
            cwd=self.sandbox, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            creationflags=getattr(__import__("subprocess"), "CREATE_NO_WINDOW", 0),
        )
        password = None
        async with asyncio.timeout(45):
            while line := await self.process.stdout.readline():
                if line.startswith(b"server password "):
                    password = line.decode().strip().split(" ", 2)[2]
                    break
        if not password:
            raise RuntimeError("OpenCode did not announce its authenticated endpoint")
        async def drain():
            async for _ in self.process.stdout:
                pass
        self.log_task = asyncio.create_task(drain())
        self.http = aiohttp.ClientSession(base_url=f"http://127.0.0.1:{port}", auth=aiohttp.BasicAuth("opencode", password),
                                          timeout=aiohttp.ClientTimeout(total=30))
        for _ in range(100):
            try:
                info = await self.request("GET", "/api/info")
                if info.get("version") == "2.2.5":
                    break
            except (aiohttp.ClientError, RuntimeError):
                await asyncio.sleep(.2)
        else:
            raise RuntimeError("OpenCode did not become ready")
        self.events_task = asyncio.create_task(self.pump())
        await asyncio.wait_for(self.ready.wait(), 15)

    async def request(self, method, path, body=None):
        async with self.http.request(method, path, json=body) as response:
            if response.status >= 400:
                raise RuntimeError(f"OpenCode request failed: HTTP {response.status} ({path.split('/')[-1]})")
            if response.status == 204:
                return None
            value = await response.json()
            return value.get("data", value) if isinstance(value, dict) else value

    async def pump(self):
        try:
            async with self.http.get("/api/event", timeout=aiohttp.ClientTimeout(total=None, sock_read=45)) as response:
                response.raise_for_status()
                self.ready.set()
                async for event in sse_events(response.content):
                    sid = event.get("data", {}).get("sessionID")
                    queue = self.queues.get(sid)
                    if queue:
                        queue.put_nowait(event)
        except asyncio.CancelledError:
            raise
        except Exception:
            for queue in self.queues.values():
                queue.put_nowait({"type": "lab.connection-lost"})

    async def create(self, model, agent="voice-lab"):
        provider, model_id = model.split("/", 1)
        permissions = session_permissions(agent)
        value = await self.request("POST", "/api/session", {
            "location": {"directory": self.sandbox.as_posix()},
            "model": {"providerID": provider, "id": model_id}, "permissions": permissions,
        })
        sid = value["id"]
        self.sessions.add(sid)
        try:
            await self.request("POST", f"/api/session/{sid}/agent", {"agent": agent})
        except BaseException:
            await self.retire(sid)
            raise
        return sid

    async def stream(self, sid, text, on_tool=None):
        if sid not in self.sessions or sid in self.queues:
            raise RuntimeError("Invalid or busy lab session")
        queue = asyncio.Queue(maxsize=2048)
        self.queues[sid] = queue
        completed = False
        try:
            await self.request("POST", f"/api/session/{sid}/prompt", {"id": "msg_lab_" + uuid.uuid4().hex, "text": text})
            async with asyncio.timeout(120):
                while True:
                    event = await queue.get()
                    kind, data = event.get("type"), event.get("data", {})
                    if kind == "session.text.delta":
                        yield data.get("delta", "")
                    elif kind == "session.tool.input.started" and on_tool:
                        await on_tool(data.get("name", "tool"))
                    elif kind == "session.execution.succeeded":
                        completed = True
                        return
                    elif kind in ("session.execution.failed", "session.error", "lab.connection-lost"):
                        raise RuntimeError("OpenCode could not complete this turn; no retry was submitted")
        finally:
            self.queues.pop(sid, None)
            if not completed:
                await asyncio.shield(self.interrupt(sid))

    async def interrupt(self, sid):
        if sid in self.sessions:
            try:
                await self.request("POST", f"/api/session/{sid}/interrupt", {})
            except (RuntimeError, aiohttp.ClientError):
                pass

    async def retire(self, sid):
        if sid in self.sessions:
            await self.interrupt(sid)
            try:
                await self.request("DELETE", f"/api/session/{sid}")
            finally:
                self.sessions.discard(sid)

    async def close(self):
        for sid in list(self.sessions):
            try:
                await self.retire(sid)
            except Exception:
                pass
        if self.events_task:
            self.events_task.cancel()
            await asyncio.gather(self.events_task, return_exceptions=True)
        if self.http:
            await self.http.close()
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 8)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        if self.log_task:
            await asyncio.gather(self.log_task, return_exceptions=True)
