"""Own a native Voxa audio host; OpenCode and tools stay in the shared lab."""
import asyncio
import os
import subprocess

import aiohttp
from opencode_bridge import free_port


class VoxaHost:
    def __init__(self, options, token):
        self.options, self.token = options, token
        self.port = free_port()
        self.process = self.http = self.drain = None

    async def start(self):
        env = {**os.environ, "VOXA_LAB_PORT": str(self.port), "VOXA_LAB_CAPABILITY": self.token,
               "VOXA_LAB_MODELS": str(self.options.kokoro), "VOXA_LAB_ESPEAK": str(self.options.espeak),
               "VOXA_LAB_WHISPER": str(self.options.whisper), "VOXA_LAB_BRIDGE": f"http://127.0.0.1:{self.options.port}",
               "DOTNET_CLI_TELEMETRY_OPTOUT": "1"}
        self.process = await asyncio.create_subprocess_exec(
            "dotnet", str(self.options.voxa_dll), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        async def drain():
            with (self.options.state / "native-error.log").open("ab") as log:
                async for line in self.process.stdout:
                    log.write(line)
                    log.flush()
        self.drain = asyncio.create_task(drain())
        self.http = aiohttp.ClientSession(base_url=f"http://127.0.0.1:{self.port}",
            headers={"Authorization": "Bearer " + self.token}, timeout=aiohttp.ClientTimeout(total=20))
        for _ in range(200):
            if self.process.returncode is not None:
                raise RuntimeError("The native Voxa host exited during startup")
            try:
                async with self.http.get("/health") as response:
                    if response.status == 200:
                        return
            except aiohttp.ClientError:
                pass
            await asyncio.sleep(.1)
        raise RuntimeError("The native Voxa host did not become ready")

    async def text(self, sid, text, background=False):
        async with self.http.post(f"/text/{sid}", json={"text": text, "background": background}) as response:
            if response.status != 200:
                raise RuntimeError("Voxa is not connected to this test session")

    async def close(self):
        if self.http:
            await self.http.close()
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 8)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        if self.drain:
            await asyncio.gather(self.drain, return_exceptions=True)
