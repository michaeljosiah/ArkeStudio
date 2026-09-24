import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { it } from "node:test";
import { build } from "esbuild";

it("each preload reads the current host theme instead of replaying window-creation arguments", async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("../src/preload.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", external: ["electron"] });
  let hostTheme = { preference: "system", resolved: "dark" };
  let bridge: { theme: typeof hostTheme } | undefined;
  const reload = () => runInNewContext(result.outputFiles[0]!.text, {
    module: { exports: {} }, exports: {},
    process: { argv: ["--arke-theme-preference=system", "--arke-resolved-theme=light"], platform: "win32" },
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name: string, value: typeof bridge) => { bridge = value; } },
      ipcRenderer: { on: () => {}, send: () => {}, sendSync: (channel: string) => {
        assert.equal(channel, "arke:get-theme");
        return { ...hostTheme };
      } },
    }),
  });
  reload();
  assert.deepEqual(bridge?.theme, hostTheme);
  hostTheme = { preference: "dark", resolved: "dark" };
  reload();
  assert.deepEqual(bridge?.theme, hostTheme);
  hostTheme = { preference: "light", resolved: "light" };
  reload();
  assert.deepEqual(bridge?.theme, hostTheme);
});

it("the bundled preload injects hello credentials but exposes neither the token nor a credentialled media URL", async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("../src/preload.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", external: ["electron"] });
  let bridge: { startupState(): unknown; coordinatorHttpBase(): string; send(json: string): void; subscribe(frame: (json: string) => void, status: (state: string) => void): void;
    importDroppedMedia(target: unknown, files: unknown[]): { submitted: boolean; unresolved: number[] } } | undefined;
  const ipc = new Map<string, (...args: unknown[]) => void>();
  const sent: string[] = [];
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    addEventListener() {}
    send(json: string) { sent.push(json); }
  }
  runInNewContext(result.outputFiles[0]!.text, {
    module: { exports: {} }, exports: {}, process: { argv: [], platform: "win32" }, WebSocket: Socket,
    require: (name: string) => {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld: (_name: string, value: typeof bridge) => { bridge = value; } },
        ipcRenderer: { on: (name: string, fn: (...args: unknown[]) => void) => ipc.set(name, fn), send: () => {}, sendSync: () => ({ preference: "system", resolved: "light" }) },
        webUtils: { getPathForFile: (file: { nativePath?: string }) => file.nativePath ?? "" },
      };
    },
  });
  assert.ok(bridge);
  const token = "d".repeat(64);
  ipc.get("arke:startup-state")!(null, { status: "ready", port: 43210, token });
  assert.equal(JSON.stringify(bridge.startupState()), '{"status":"ready"}');
  assert.equal(bridge.coordinatorHttpBase(), "http://127.0.0.1:43210");
  assert.equal(JSON.stringify(bridge).includes(token), false);
  const states: string[] = [];
  bridge.subscribe(() => {}, state => states.push(state));
  assert.deepEqual(states, ["open"], "a late subscriber can authenticate an already-open socket");
  bridge.send(JSON.stringify({ kind: "hello", lastSeq: 42, token: "untrusted-renderer-value" }));
  assert.deepEqual(JSON.parse(sent[0]!), { kind: "hello", lastSeq: 42, token });
  bridge.send('{"kind":"open-world","worldId":"a-world"}');
  assert.equal(sent[1], '{"kind":"open-world","worldId":"a-world"}');
  const target = { worldId: "world", requestId: "request", editor: { productionId: "film", destination: 24, baseRevision: 3, sourceFingerprint: "story-picture-v1:1234567890abcdef" } };
  const imported = bridge.importDroppedMedia(target, [{ nativePath: "C:/private/first.mp4" }, { nativePath: "C:/private/second.mp4" }]);
  assert.equal(JSON.stringify(imported), '{"submitted":true,"unresolved":[]}');
  assert.deepEqual(JSON.parse(sent[2]!), { ...target, kind: "upload-artifacts", sourcePaths: ["C:/private/first.mp4", "C:/private/second.mp4"] });
  const unresolved = bridge.importDroppedMedia(target, [{ nativePath: "C:/private/first.mp4" }, {}]);
  assert.equal(JSON.stringify(unresolved), '{"submitted":true,"unresolved":[1]}');
  assert.deepEqual(JSON.parse(sent[3]!), { ...target, kind: "upload-artifacts", sourcePaths: ["C:/private/first.mp4", null] });
  assert.equal(sent.length, 4, "valid paths retain their original indices alongside virtual files");
  assert.equal(bridge.importDroppedMedia(target, Array.from({ length: 17 }, () => ({ nativePath: "C:/private/file.mp4" }))).submitted, false);
});

it("hands a Stage export over only after every reference image has been spooled", async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("../src/preload.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", external: ["electron"] });
  let bridge: { finishStageExport(target: unknown, job: string, opening: Uint8Array, frames: Array<{ kind: string; at: number; bytes: Uint8Array }>): Promise<{ ok: boolean }> } | undefined;
  const ipc = new Map<string, (...args: unknown[]) => void>();
  const sent: string[] = [];
  let failFrame = false;
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    addEventListener() {}
    send(json: string) { sent.push(json); }
  }
  runInNewContext(result.outputFiles[0]!.text, {
    module: { exports: {} }, exports: {}, process: { argv: [], platform: "win32" }, WebSocket: Socket,
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name: string, value: typeof bridge) => { bridge = value; } },
      ipcRenderer: { on: (name: string, fn: (...args: unknown[]) => void) => ipc.set(name, fn), send: () => {}, sendSync: () => ({ preference: "system", resolved: "light" }),
        invoke: async (channel: string, value: { name: string }) => {
          if (channel === "arke:stage-export-finish") return { ok: true, path: "/private/playblast.mp4" };
          assert.equal(channel, "arke:spool");
          if (failFrame && value.name === "stage-reference-1.png") return { reason: "spool failed" };
          return { path: `/private/${value.name}` };
        },
      },
    }),
  });
  ipc.get("arke:startup-state")!(null, { status: "ready", port: 43210, token: "d".repeat(64) });
  assert.ok(bridge);
  const target = { kind: "stage-playblast", shotId: "sh_12" };
  const frames = [{ kind: "last", at: 119 / 30, bytes: new Uint8Array([1]) }, { kind: "overview", at: 0, bytes: new Uint8Array([2]) }];
  assert.equal((await bridge.finishStageExport(target, "job", new Uint8Array([0]), frames)).ok, true);
  assert.deepEqual(JSON.parse(sent[0]!), { ...target, sourcePath: "/private/playblast.mp4", openingFrameSourcePath: "/private/opening-frame.png", referenceFrames: [
    { kind: "last", at: 119 / 30, sourcePath: "/private/stage-reference-0.png" },
    { kind: "overview", at: 0, sourcePath: "/private/stage-reference-1.png" },
  ] });
  failFrame = true;
  assert.equal((await bridge.finishStageExport(target, "job", new Uint8Array([0]), frames)).ok, false);
  assert.equal(sent.length, 1, "a partial image set never reaches the filing command");
});
