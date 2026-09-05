import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { it } from "node:test";
import { build } from "esbuild";

it("the bundled preload injects hello credentials but exposes neither the token nor a credentialled media URL", async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("../src/preload.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", external: ["electron"] });
  let bridge: { startupState(): unknown; coordinatorHttpBase(): string; send(json: string): void; subscribe(frame: (json: string) => void, status: (state: string) => void): void } | undefined;
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
});
