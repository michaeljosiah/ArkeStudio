import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { FileStudioConversationStore } from "../../src/studio-assistant/store.js";
import { StudioAssistantService } from "../../src/studio-assistant/service.js";
import { studioDiagnosticEvidence } from "../../src/studio-assistant/evidence.js";
import { atomicWriteFile } from "../../src/world/atomic.js";
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";

it("a replacement waits for an old admitted file write after bounded shutdown before reading or saving history", async () => {
  const path = join(await tempDir("arke-studio-late-history-"), "history.json");
  let finish!: () => void, entered = false;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const store = new FileStudioConversationStore(path, async (target, text) => { entered = true; await held; await atomicWriteFile(target, text); });
  const deps = { model: { busy: () => false, stop: async () => {}, run: async () => { throw new Error("No model was requested"); } },
    evidence: (topic: Parameters<typeof studioDiagnosticEvidence>[0]) => studioDiagnosticEvidence(topic, {}, Date.now()), shutdownMs: 10 };
  const old = new StudioAssistantService({ ...deps, store }), next = new StudioAssistantService({ ...deps, store: new FileStudioConversationStore(path) });
  try {
    const creating = old.createThread(); await until(() => entered, "old history write admitted"); await old.stop();
    let loaded = false; const opening = next.open().then(() => { loaded = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(loaded, false, "No replacement read while the old atomic rename is uncertain");
    finish(); await creating; await opening; assert.equal(next.snapshot().threads.length, 1);
    assert(await next.createThread()); assert.equal(next.snapshot().threads.length, 2);
    assert.equal(JSON.parse(await readFile(path, "utf8")).threads.length, 2);
  } finally { finish(); await old.stop(); await next.stop(); }
});
