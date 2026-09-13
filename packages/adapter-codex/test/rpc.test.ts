import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { CodexRpc } from "../src/rpc.js";

test("dispose awaits the same cleanup already begun by process exit", async () => {
  let unblock!: () => void; let called!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const cleanupStarted = new Promise<void>(resolve => { called = resolve; });
  const rpc = new CodexRpc({ command: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 50)"],
    onNotification: () => {}, onRequest: async () => ({ result: {} }), onFailure: () => {},
    killProcess: async () => { called(); await blocked; } });
  await rpc.start(); await cleanupStarted;
  let completed = false; const disposed = rpc.dispose().then(() => { completed = true; });
  await delay(20); assert.equal(completed, false); unblock(); await disposed; assert.equal(completed, true);
});
