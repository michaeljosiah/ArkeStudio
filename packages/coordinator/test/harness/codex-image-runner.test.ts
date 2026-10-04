import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { lazyCodexImageRunner } from "../../src/harness/v2-launch.js";

const FOUND = { command: "codex", args: [], helper: "", source: "path" as const, version: "0.160.0" };
function rig(over: { found?: typeof FOUND | null; initFails?: boolean; path?: { value: string } } = {}) {
  const log: string[] = []; let discoveries = 0;
  const runner = lazyCodexImageRunner({
    idleMs: 40,
    ...(over.path ? { discovery: () => (over.path!.value ? { configuredPath: over.path!.value } : {}) } : {}),
    discover: async () => { discoveries++; return { found: over.found === undefined ? FOUND : over.found, reason: over.found === null ? "Codex was not found on this machine." : null }; },
    createAdapter: () => {
      const id = log.filter(line => line.startsWith("create")).length + 1; log.push(`create ${id}`);
      return {
        init: async () => { if (over.initFails) throw new Error("init failed"); },
        imageStatus: async () => ({ authMode: "chatgpt" as const, imageGeneration: true }),
        generateImage: async () => ({ bytes: Buffer.from("x"), mimeType: "image/png" as const }),
        dispose: async () => { log.push(`dispose ${id}`); },
      } as never;
    },
  });
  return { runner, log, discoveries: () => discoveries };
}

test("nothing is discovered or started until the first ask, and one adapter serves later asks", async () => {
  const r = rig();
  assert.equal(r.discoveries(), 0); assert.deepEqual(r.log, []);
  assert.deepEqual(await r.runner.status(), { authMode: "chatgpt", imageGeneration: true });
  await r.runner.generate({ prompt: "x", references: [] });
  assert.deepEqual(r.log, ["create 1"]); assert.equal(r.discoveries(), 1);
  await r.runner.dispose();
});

test("an idle app-server is stopped and the next ask starts a fresh one", async () => {
  const r = rig();
  await r.runner.status();
  await delay(120);
  assert.deepEqual(r.log, ["create 1", "dispose 1"]);
  await r.runner.status();
  assert.deepEqual(r.log, ["create 1", "dispose 1", "create 2"]);
  await r.runner.dispose();
  assert.deepEqual(r.log.slice(-1), ["dispose 2"]);
});

test("an absent Codex is an ordinary failure that is looked for again", async () => {
  const r = rig({ found: null });
  await assert.rejects(r.runner.status(), /not found on this machine/);
  await assert.rejects(r.runner.status(), /not found on this machine/);
  assert.equal(r.discoveries(), 2); await r.runner.dispose();
});

test("a failed start is disposed and not remembered", async () => {
  const r = rig({ initFails: true });
  await assert.rejects(r.runner.status(), /init failed/);
  await assert.rejects(r.runner.status(), /init failed/);
  assert.deepEqual(r.log, ["create 1", "dispose 1", "create 2", "dispose 2"]);
  await r.runner.dispose();
});

test("dispose is terminal: a later ask is refused rather than starting a new app-server", async () => {
  const r = rig();
  await r.runner.status(); await r.runner.dispose();
  await assert.rejects(r.runner.status(), /has been stopped/);
  await assert.rejects(r.runner.generate({ prompt: "x", references: [] }), /has been stopped/);
  assert.deepEqual(r.log, ["create 1", "dispose 1"]);
});

test("a Codex path chosen in Settings replaces the running app-server at the next ask", async () => {
  const path = { value: "" };
  const r = rig({ path });
  await r.runner.status();
  path.value = "/opt/codex";
  await r.runner.status();
  assert.deepEqual(r.log, ["create 1", "dispose 1", "create 2"]);
  await r.runner.status();
  assert.deepEqual(r.log, ["create 1", "dispose 1", "create 2"], "an unchanged path keeps the one running");
  await r.runner.dispose();
});
