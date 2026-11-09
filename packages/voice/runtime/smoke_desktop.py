"""Opt-in packaged desktop acceptance in a fresh owned profile; no developer runtime."""
import argparse
import asyncio
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import shutil
import subprocess

import aiohttp
from websockets.asyncio.client import connect


class ChildExitProof:
    """Retain exact process handles before shutdown; ledger rows may outlive exit."""
    def __init__(self):
        self.handles = []
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]

    def retain(self, children, owner, resources):
        for row in children:
            assert row["ownerPid"] == owner, "Child ledger belongs to another app instance"
            handle = self.kernel.OpenProcess(0x100000 | 0x1000, False, row["pid"])
            if not handle:
                if ctypes.get_last_error() == 87:  # Already absent.
                    continue
                raise ctypes.WinError(ctypes.get_last_error())
            self.handles.append(handle)
            image, size = ctypes.create_unicode_buffer(32768), wintypes.DWORD(32768)
            if not self.kernel.QueryFullProcessImageNameW(handle, 0, image, ctypes.byref(size)):
                raise ctypes.WinError(ctypes.get_last_error())
            executable = Path(image.value).resolve()
            console_host = Path(os.environ["SystemRoot"]) / "System32/conhost.exe"
            assert executable.is_relative_to(resources) or executable == console_host, "Child image escaped the package and its Windows console host"

    def exited(self):
        return all(self.kernel.WaitForSingleObject(handle, 0) == 0 for handle in self.handles)

    def close(self):
        for handle in self.handles:
            self.kernel.CloseHandle(handle)


class Devtools:
    def __init__(self, socket):
        self.socket, self.serial, self.pending = socket, 0, {}
        self.reader = asyncio.create_task(self.read())

    async def read(self):
        try:
            async for raw in self.socket:
                message = json.loads(raw)
                future = self.pending.pop(message.get("id"), None)
                if future and not future.done():
                    if "error" in message:
                        future.set_exception(RuntimeError("Packaged renderer inspection failed"))
                    else:
                        future.set_result(message.get("result", {}))
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(RuntimeError("Packaged renderer closed"))

    async def call(self, method, params):
        self.serial += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[self.serial] = future
        await self.socket.send(json.dumps({"id": self.serial, "method": method, "params": params}))
        return await asyncio.wait_for(future, 120)

    async def evaluate(self, expression):
        result = await self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
        if result.get("exceptionDetails"):
            raise RuntimeError("Packaged renderer could not inspect its speech state")
        return result.get("result", {}).get("value")


async def check(options):
    root = options.root.resolve()
    root.mkdir()  # Refuse every existing profile, including another acceptance run.
    (root / ".arke-packaged-speech-smoke").write_text("1\n", encoding="utf-8")
    workspace, profile = root / "workspace", root / "profile"
    models = workspace / "models"
    models.mkdir(parents=True)
    print(json.dumps({"stage": "copying-owned-models", "mode": options.mode}), flush=True)
    shutil.copytree(options.kokoro, models / "kokoro-82m")
    (models / "whisper-base-en").mkdir()
    shutil.copyfile(options.alignment_model, models / "whisper-base-en/ggml-base.en.bin")
    if options.mode not in ("missing-whisper", "corrupt-whisper"):
        shutil.copytree(options.whisper, models / "faster-whisper-base-en")
    elif options.mode == "corrupt-whisper":
        target = models / "faster-whisper-base-en"
        target.mkdir()
        for name in ("config.json", "tokenizer.json", "vocabulary.txt"):
            shutil.copyfile(options.whisper / name, target / name)
        (target / "model.bin").write_bytes(b"deliberately invalid owned test model")
    settings = workspace / "settings.json"
    original = None
    if options.mode == "upgrade":
        original = '{"appearance":{"theme":"dark"},"voxa":{"executablePath":null,"extraArgs":[]}}\n'
        settings.write_text(original, encoding="utf-8")
    env = {name: os.environ[name] for name in ("SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "LOCALAPPDATA", "APPDATA") if name in os.environ}
    env.update(ARKE_STUDIO_ROOT=str(workspace), PATH=str(Path(os.environ["SystemRoot"]) / "System32"), TEMP=str(root), TMP=str(root))
    args = [str(options.app.resolve()), "--remote-background", f"--user-data-dir={profile}", "--remote-debugging-port=0"]
    log = (root / "desktop-startup.log").open("wb")
    print(json.dumps({"stage": "starting-packaged-app"}), flush=True)
    process = subprocess.Popen(args, env=env, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
    devtools, socket = None, None
    proof = ChildExitProof()
    children = []
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as client:
            async with asyncio.timeout(120):
                while True:
                    if process.poll() is not None:
                        raise RuntimeError("Packaged app exited before speech readiness; inspect owned startup log")
                    try:
                        port = int((profile / "DevToolsActivePort").read_text(encoding="utf-8").splitlines()[0])
                        async with client.get(f"http://127.0.0.1:{port}/json/list") as response:
                            pages = await response.json()
                        page = next((row for row in pages if row.get("type") == "page" and "/client/index.html" in row.get("url", "")), None)
                        if page:
                            break
                    except (FileNotFoundError, ValueError, aiohttp.ClientError):
                        pass
                    await asyncio.sleep(.25)
            socket = await connect(page["webSocketDebuggerUrl"], max_size=4 * 1024**2)
            devtools = Devtools(socket)
            expression = """(() => {
              if (!window.arke) return null;
              if (!window.__speechSmokeSubscribed) {
                window.__speechSmokeSubscribed = true;
                window.arke.subscribe(raw => {
                  const frame = JSON.parse(raw);
                  if (frame.kind === 'snapshot') {
                    window.__speechSmokeRuntime = frame.state.app.voiceRuntime;
                    window.__speechSmokeProviders = frame.state.app.providers;
                  }
                  if (frame.kind === 'event' && frame.event.type === 'voice.sidecar') window.__speechSmokeRuntime = frame.event.runtime;
                  if (frame.kind === 'event' && frame.event.type === 'provider.status') window.__speechSmokeProviders = frame.event.providers;
                  if (frame.kind === 'event' && frame.event.type === 'voice.runtime-test' && frame.event.requestId === '01J00000000000000000000000' && frame.event.status !== 'testing') {
                    window.__speechSmokeVoiceTest = frame.event.status;
                    if (frame.event.status === 'ready') window.arke.send(JSON.stringify({kind:'transcribe-dictation', requestId:'packaged-smoke-dictation', audioBase64:frame.event.audioBase64, contentType:'audio/wav'}));
                  }
                  if (frame.kind === 'event' && frame.event.type === 'dictation.result' && frame.event.requestId === 'packaged-smoke-dictation') window.__speechSmokeDictation = frame.event;
                }, status => { if (status === 'open') window.arke.send(JSON.stringify({kind:'hello'})); });
                window.arke.connect();
              }
              return {runtime: window.__speechSmokeRuntime ?? null, providers: window.__speechSmokeProviders ?? []};
            })()"""
            last_status = None
            async with asyncio.timeout(300):
                while True:
                    state = await devtools.evaluate(expression)
                    runtime = state.get("runtime") if state else None
                    if runtime:
                        current_status = (runtime.get("backend"), runtime.get("processState"), runtime.get("engineStatus", {}).get("kokoro", {}).get("state"), runtime.get("engineStatus", {}).get("whisper", {}).get("state"))
                        if current_status != last_status:
                            print(json.dumps({"speechState": current_status}), flush=True)
                            last_status = current_status
                    if runtime and runtime.get("processState") == "healthy":
                        status = runtime.get("engineStatus", {})
                        if status.get("kokoro", {}).get("state") == "ready":
                            whisper = status.get("whisper", {}).get("state")
                            if whisper == "ready" or options.mode in ("missing-whisper", "corrupt-whisper") and whisper in ("missing", "verification-failed", "unavailable"):
                                providers = {row["id"]: row for row in state["providers"]}
                                if providers.get("kokoro", {}).get("validation") == "valid" and (whisper != "ready" or providers.get("whispercpp", {}).get("validation") == "valid"):
                                    break
                    await asyncio.sleep(.5)
            expected = "voxa" if options.mode == "upgrade" else "pipecat"
            assert runtime.get("backend") == expected, "Packaged backend selection differs from rollout policy"
            if options.mode in ("missing-whisper", "corrupt-whisper"):
                assert runtime["engineStatus"]["whisper"]["state"] != "ready"
                assert runtime["engineStatus"]["whisper"].get("detail"), "Recognition failure needs a named remedy"
            if original is None:
                assert json.loads(settings.read_text(encoding="utf-8"))["voxa"]["backend"] == "pipecat"
            if options.mode in ("ready", "upgrade"):
                await devtools.evaluate("window.arke.send(JSON.stringify({kind:'test-local-voice',requestId:'01J00000000000000000000000'})); true")
                async with asyncio.timeout(90):
                    while True:
                        roundtrip = await devtools.evaluate("({speech:window.__speechSmokeVoiceTest, dictation:window.__speechSmokeDictation})")
                        assert roundtrip.get("speech") != "failed", "Packaged host synthesis failed"
                        if roundtrip.get("dictation"):
                            assert not roundtrip["dictation"].get("error"), "Packaged host dictation failed"
                            assert "remembers" in (roundtrip["dictation"].get("text") or "").lower(), "Packaged host recognition lost the synthetic phrase"
                            break
                        await asyncio.sleep(.25)
            ledger = workspace / "run/children.json"
            children = json.loads(ledger.read_text(encoding="utf-8")).get("children", []) if ledger.exists() else []
            assert children, "The packaged runtime must be supervised"
            proof.retain(children, process.pid, options.app.resolve().parent / "resources")
            result = {"mode": options.mode, "backend": expected, "processState": runtime["processState"],
                      "kokoro": runtime["engineStatus"]["kokoro"]["state"], "whisper": runtime["engineStatus"]["whisper"]["state"],
                      "privateProfile": True, "developerPathsRemoved": True, "physicalMicrophoneQualified": False,
                      "hostSpeechDictationRoundtrip": options.mode in ("ready", "upgrade"),
                      "supervisedChildren": [{"pid": row["pid"], "id": row["id"], "image": row["image"]} for row in children]}
            try:
                await devtools.evaluate("window.arke.quit(); true")
            except RuntimeError:
                pass  # Closing its own renderer can win the reply race.
            await asyncio.to_thread(process.wait, 90)
            assert process.returncode == 0, "Packaged shutdown did not complete normally"
            async with asyncio.timeout(10):
                while not proof.exited():
                    await asyncio.sleep(.1)
            result["retainedLedgerRecords"] = len(json.loads(ledger.read_text(encoding="utf-8")).get("children", []))
            if original is not None:
                assert settings.read_text(encoding="utf-8") == original, "Upgrade rewrote existing settings"
            result["cleanShutdown"] = True
            (root / "evidence.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
            print(json.dumps(result), flush=True)
    finally:
        proof.close()
        if socket:
            await socket.close()
        if devtools:
            await asyncio.gather(devtools.reader, return_exceptions=True)
        if process.poll() is None:
            # Only this newly created root process and its descendants; never a name-wide kill.
            subprocess.run([str(Path(os.environ["SystemRoot"]) / "System32/taskkill.exe"), "/pid", str(process.pid), "/T", "/F"], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
            await asyncio.to_thread(process.wait, 20)
        log.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("app", "root", "kokoro", "whisper", "alignment-model"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--mode", choices=("ready", "upgrade", "missing-whisper", "corrupt-whisper"), default="ready")
    asyncio.run(check(parser.parse_args()))
