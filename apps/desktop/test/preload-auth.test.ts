import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { it } from "node:test";
import { build } from "esbuild";

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
        ipcRenderer: { on: (name: string, fn: (...args: unknown[]) => void) => ipc.set(name, fn), send: () => {} },
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
