import assert from "node:assert/strict";
import { it } from "node:test";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { newId, type ConversationId, type RunId } from "@arke-studio/contracts";
import { conversationRunDependencies, type ConversationRunDependencies } from "../../src/application/conversation-runs.js";
import { ConversationAuthoringService } from "../../src/application/conversation-authoring.js";
import { ConversationActionLifecycle } from "../../src/arke-actions/lifecycle.js";
import { WorldChatService } from "../../src/world-chat/service.js";
import { WorldStore } from "../../src/world/store.js";
import { createProduction, createChapter, saveChapter } from "../../src/productions/ops.js";
import type { TurnOutcome } from "../../src/world-chat/run.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup, tempDir } from "../tmp.js";

async function fixture() {
  const store = await WorldStore.open(await makeTempWorld());
  closeOnCleanup(() => store.close());
  const scratchRoot = await tempDir("arke-run-service-");
  let active: WorldStore | null = store;
  let research = false;
  type Surface = Parameters<ConversationRunDependencies["query"]["attachLease"]>[1];
  const surfaces = new Map<string, Surface>();
  const deps = conversationRunDependencies(store, {
    adapter: null, sessionInput: input => input ?? {}, scratchRoot,
    summaryDir: join(scratchRoot, "summary"), activeStore: () => active,
    query: {
      start: async () => "http://127.0.0.1:1234/mcp",
      attachLease: (token, surface) => { surfaces.set(token, surface); },
      detachLease: token => { surfaces.delete(token); },
      leasedUrl: token => `http://127.0.0.1:1234/mcp/${token}`,
    },
    actions: new ConversationActionLifecycle({ worldId: store.worldId, worldPath: store.dir }),
    jobs: () => [], exports: async () => [], actionExports: () => [],
    researchAllowed: () => research, resolveLanguageModel: async () => ({}),
    onTurnFailed: () => {}, onProgress: () => {},
  });
  const conversationId = newId("cv") as ConversationId;
  const runId = newId("run") as RunId;
  return { store, deps, surfaces, conversationId, runId,
    select: (value: WorldStore | null) => { active = value; },
    research: (value: boolean) => { research = value; } };
}

it("a writing run revokes its lease and removes scratch on release", async () => {
  const h = await fixture();
  const input = { conversationId: h.conversationId, runId: h.runId, attachmentIds: [] };
  const prepared = await h.deps.prepare(input);
  await access(prepared.cwd);
  const surface = h.surfaces.get(prepared.leaseToken)!;
  assert.ok(surface);
  await surface.retrieval.call(prepared.leaseToken, "list_entities", {});
  h.select(null);
  await assert.rejects(surface.retrieval.call(prepared.leaseToken, "list_entities", {}), /No world is open/);
  await h.deps.release(input);
  assert.equal(h.surfaces.size, 0);
  await assert.rejects(access(prepared.cwd));
  h.select(h.store);
  await assert.rejects(surface.retrieval.call(prepared.leaseToken, "list_entities", {}));
  assert.deepEqual(h.deps.receiptsFor(h.runId), []);
});

it("the extracted assembly grounds a chapter in the previous prose and keeps its read receipts", async () => {
  const h = await fixture();
  await createProduction(h.store, { title: "Inkbound", format: "story" });
  const first = await createChapter(h.store, "inkbound", { title: "First", order: 1 });
  const second = await createChapter(h.store, "inkbound", { title: "Second", order: 2 });
  await saveChapter(h.store, "inkbound", first, "The lantern went out beside the silver river.");
  const input = { conversationId: h.conversationId, runId: h.runId, attachmentIds: [] };
  const prepared = await h.deps.prepare(input);
  try {
    const brief = await h.deps.chapterBrief!({ leaseToken: prepared.leaseToken, productionId: "inkbound", chapterId: second, budgetChars: 100_000 });
    assert.match(brief, /The lantern went out beside the silver river/);
    assert.match(brief, /Plan: Second/);
    assert.ok(h.deps.receiptsFor(h.runId).length >= 3);
  } finally { await h.deps.release(input); }
});

it("send returns the running turn before completion and starts optional naming afterwards", async () => {
  const h = await fixture();
  const chats = new WorldChatService(h.store.dir);
  const conversation = await chats.create({ title: "New conversation" });
  const calls: string[] = [];
  let finish!: (outcome: TurnOutcome) => void;
  const pending = new Promise<TurnOutcome>(resolve => { finish = resolve; });
  const service = new ConversationAuthoringService(h.store, {
    runner: () => ({ send: () => { calls.push("send"); return pending; }, retry: async () => ({ status: "cancelled" }), cancel: () => true }),
    name: async () => { calls.push("name"); return false; },
  });
  const started = await service.send({ conversationId: conversation.id, text: "A lantern beside the river" });
  assert.ok(started);
  assert.deepEqual(calls, ["send", "name"]);
  assert.equal((await chats.load(conversation.id))?.title, "A lantern beside the river");
  finish({ status: "completed", reply: "A beginning." });
  assert.deepEqual(await started.completion, { status: "completed", reply: "A beginning." });
  assert.equal(await started.naming, false);
});

it("a missing production context refuses before a runner or naming pass is started", async () => {
  const h = await fixture();
  const conversation = await new WorldChatService(h.store.dir).create({ title: "Missing", entryContext: { kind: "production", productionId: "missing" } });
  const service = new ConversationAuthoringService(h.store, {
    runner: () => { throw new Error("must not start"); },
    name: async () => { throw new Error("must not name"); },
  });
  assert.equal(await service.send({ conversationId: conversation.id, text: "Write it" }), null);
});

it("the prose service preserves stale-save refusal and reloads saved bytes after reopening", async () => {
  const { ProseAuthoringService } = await import("../../src/application/prose-authoring.js");
  const h = await fixture();
  await createProduction(h.store, { title: "Inkbound", format: "story" });
  const prose = new ProseAuthoringService(h.store);
  const chapter = await prose.create("inkbound", { title: "First", order: 1 });
  const opened = await prose.open("inkbound", chapter);
  const saved = await prose.save("inkbound", chapter, "The river answered.", { baseHash: opened.hash });
  await assert.rejects(prose.save("inkbound", chapter, "A stale replacement.", { baseHash: opened.hash }));
  const current = await prose.open("inkbound", chapter);
  assert.equal(current.body, "The river answered.\n");
  assert.equal(current.hash, saved.hash);
  assert.equal(current.version, opened.version, "direct authoring must not cut an accepted proposal version");
  const dir = h.store.dir;
  await h.store.close();
  const reopened = await WorldStore.open(dir);
  closeOnCleanup(() => reopened.close());
  assert.equal((await new ProseAuthoringService(reopened).open("inkbound", chapter)).body, current.body);
});
