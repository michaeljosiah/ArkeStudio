import assert from "node:assert/strict";
import { join } from "node:path";
import { createEngine } from "@arke-studio/engine";
import { FsWorldProvider, createLocalWorldRepository, FileEngineOperationStore, JobQueue, JobJournal } from "@arke-studio/engine/local";
const worldId = "01J8F3K2QW9VZX4N7M0RTYB6HC";
const context = { actorId: "parent", scopeId: "family", subjectId: "child", executorId: "worker" };
const root = join(process.cwd(), "app");
const provider = new FsWorldProvider(root);
await provider.loadWorld(worldId);
let submissions = 0;
const ledger = new Set();
const bytes = Uint8Array.from([137,80,78,71,13,10,26,10,...Array(64).fill(0),0,0,0,0,73,69,78,68,174,66,96,130]);
const client = {
  declarations: { supportsIdempotencyKey: true, supportsLookupByKey: false, supportsListRecent: false, reportsCost: false },
  async submit() { submissions++; return { remoteId: "remote-1" }; },
  async poll() { return { state: "succeeded" }; },
  async fetchArtifacts() { return [{ name: "portrait.png", contentType: "image/png", data: bytes }]; },
  async cancel() {},
};
const queue = new JobQueue({ journal: new JobJournal(join(root, "jobs.jsonl")), journalPath: join(root, "scratch/jobs.jsonl"),
  clients: { test: client }, getKey: async () => "host-scoped-key", emit() {},
  ledger: { readJobIds: async () => ledger, has: async id => ledger.has(id), append: async row => { ledger.add(row.jobId); } },
  landInWorld: async (id, fn) => { assert.equal(id, worldId); await fn(join(root, "worlds/the-undersong")); return true; },
  pollIntervalMs: 5, baseIntervalMs: 1 });
await queue.start();
const policy = {
  async authorise(ctx, action, resource) {
    if (ctx.scopeId !== "family" || resource.worldId !== worldId || (ctx.actorId === "child" && !["read", "media"].includes(action))) throw new Error("Forbidden");
  },
  async project(ctx, bundle) { if (ctx.actorId === "child") bundle.proposals = []; return bundle; },
  async deliver(ctx, resource) { await this.authorise(ctx, "read", resource); },
  async reserve(_ctx, key) { return key; }, async settle() {}, async release() {},
};
const make = () => createEngine({ worlds: createLocalWorldRepository(provider), policy,
  operations: new FileEngineOperationStore(join(root, "operations.jsonl")),
  queue: { enqueue: input => queue.enqueue(input), jobs: () => queue.listJobs() } });
let engine = make();
try {
  const opened = await engine.worlds.read(context, worldId);
  assert.equal(opened.bundle.meta.worldId, worldId);
  const proposal = await engine.proposals.propose(context, worldId,
    { operationId: "character", sheetType: "character", name: "External Fenn", sentence: "A brave fox." });
  const accepted = await engine.proposals.accept(context, worldId, proposal.value.proposal.id, { operationId: "accept" });
  assert.equal(accepted.value.status, "accepted");
  const model = { id: "portrait", provider: "test", capability: "image", displayName: "Test portrait",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: { resolutions: ["1MP"], tiers: { "1K": "1MP" }, aspects: ["1:1"] },
    pricing: { kind: "perMegapixel", microUsdPerMegapixel: 1 } };
  const generated = await engine.illustrations.generate(context, worldId, { operationId: "image", sheetId: proposal.value.slug,
    model, prompt: "Smiling", count: 1, identityReferences: [], generationKey: "image" });
  const deadline = Date.now() + 10000;
  while (queue.listJobs().some(job => job.status !== "succeeded")) {
    if (Date.now() > deadline) throw new Error("Generation timed out: " + JSON.stringify(queue.listJobs()));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const job = queue.listJobs()[0];
  const media = await engine.worlds.media({ ...context, actorId: "child" }, worldId, `${job.landing.dir}/${job.landing.name}`);
  assert.ok(media.bytes.length > 0);
  await engine.illustrations.reconcile(context, worldId, "image");
  const productionInput = { operationId: "prose-production", title: "The river path" };
  const production = await engine.prose.createProduction(context, worldId, productionInput);
  const proseId = production.value.productionId;
  const chapterInput = { operationId: "prose-chapter", title: "Home", order: 1 };
  const chapter = await engine.prose.createChapter(context, worldId, proseId, chapterInput);
  const chapterId = chapter.value.chapterId;
  const openedChapter = await engine.prose.readChapter(context, worldId, proseId, chapterId);
  const saveInput = { operationId: "prose-save", body: "Fenn followed the river home.", baseHash: openedChapter.hash,
    expectedRevision: chapter.revision };
  const saved = await engine.prose.saveChapter(context, worldId, proseId, chapterId, saveInput);
  assert.equal(saved.value.version, openedChapter.version);
  await engine.close(); await provider.close(); await provider.loadWorld(worldId); engine = make();
  assert.deepEqual(await engine.prose.createProduction(context, worldId, productionInput), production);
  assert.deepEqual(await engine.prose.createChapter(context, worldId, proseId, chapterInput), chapter);
  assert.deepEqual(await engine.prose.saveChapter(context, worldId, proseId, chapterId, saveInput), saved);
  const reopenedChapter = await engine.prose.readChapter(context, worldId, proseId, chapterId);
  assert.equal(reopenedChapter.body.trim(), saveInput.body);
  assert.equal(reopenedChapter.hash, saved.value.hash);
  await assert.rejects(engine.prose.saveChapter({ ...context, actorId: "child" }, worldId, proseId, chapterId,
    { ...saveInput, operationId: "child-save" }), /Forbidden/);
  assert.deepEqual(await engine.proposals.accept(context, worldId, proposal.value.proposal.id, { operationId: "accept" }), accepted);
  assert.equal((await engine.operation(context, worldId, "image")).status, "completed");
  assert.equal(submissions, 1); assert.equal(generated.jobIds.length, 1);
  await assert.rejects(engine.worlds.read({ ...context, scopeId: "unrelated" }, worldId), /Forbidden/);
  console.log("external journey complete");
} finally { queue.stopAccepting(); queue.dispose(); await queue.drain(); await engine.close(); await provider.close(); }
