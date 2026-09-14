import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { join } from "node:path";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createEngine, engineHash, type EnginePolicy, type EngineContext } from "../../src/application/engine.js";
import { createLocalWorldRepository } from "../../src/application/local-worlds.js";
import { FileEngineOperationStore } from "../../src/application/local-operations.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { JobQueue } from "../../src/queue/dispatcher.js";
import { JobJournal } from "../../src/queue/journal.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { FakeProvider, pngBytes } from "../queue/fake-provider.js";
import { FAL_MODELS } from "../../../providers/src/fal-catalogue.generated.js";
import { until } from "../wait.js";

const parent: EngineContext = { actorId: "parent", scopeId: "family", executorId: "worker", subjectId: "child" };
const child: EngineContext = { ...parent, actorId: "child" };
const draft = { operationId: "new-character", sheetType: "character" as const, name: "Fenn", sentence: "A brave little fox." };

async function harness(t: TestContext) {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  await provider.loadWorld(WORLD_ID);
  const fake = new FakeProvider({ supportsIdempotencyKey: true });
  fake.artifacts = [{ name: "portrait.png", contentType: "image/png", data: pngBytes() }];
  const state = { revoked: false, held: false, refuse: false, failSave: false, failSettlement: false, saves: 0, charges: 0, releases: 0 };
  const settled = new Set<string>();
  const policy: EnginePolicy = {
    async authorise(context, action, resource) {
      if (context.scopeId !== "family" || resource.worldId !== WORLD_ID || state.revoked ||
        (context.actorId === "child" && !["read", "media"].includes(action))) throw new Error("Forbidden");
    },
    async project(context, bundle) { if (context.actorId === "child") bundle.proposals = []; return bundle; },
    async deliver(context, resource, content) {
      await policy.authorise(context, "read", resource);
      if (state.held && ["artifact", "job"].includes(content.kind)) throw new Error("Held");
    },
    async reserve(_context, key) { if (state.refuse) throw new Error("No allowance"); return key; },
    async settle(_context, key) {
      if (!settled.has(key)) { state.charges++; settled.add(key); }
      if (state.failSettlement) throw new Error("Response lost");
    },
    async release(_context, key) { if (!settled.has(key)) { state.releases++; settled.add(key); } },
  };
  const ledger = new Set<string>();
  const journal = new JobJournal(join(root, "durable-jobs.jsonl"));
  const queue = new JobQueue({ journal, journalPath: join(root, "scratch", "unused.jsonl"),
    clients: { fal: fake }, getKey: async () => "scoped-test-key", emit() {},
    ledger: { readJobIds: async () => ledger, has: async id => ledger.has(id), append: async entry => { ledger.add(entry.jobId); } },
    landInWorld: async (worldId, fn) => { assert.equal(worldId, WORLD_ID); await fn(worldDir); return true; },
    pollIntervalMs: 5, baseIntervalMs: 1 });
  await queue.start();
  const make = () => createEngine({ policy, operations: new FileEngineOperationStore(join(root, "operations.jsonl")),
    worlds: createLocalWorldRepository(provider, { finalise: async () => {
      if (state.failSave) throw new Error("Authoritative save unavailable"); state.saves++; return { revision: String(state.saves) };
    } }), queue: { enqueue: input => queue.enqueue(input), jobs: () => queue.listJobs() } });
  let engine = make();
  t.after(async () => { queue.stopAccepting(); queue.dispose(); await queue.drain(); await engine.close(); await provider.close(); });
  return { engine, provider, queue, fake, state, policy, root, worldDir,
    restart: async () => { await engine.close(); engine = make(); return engine; } };
}

it("real gate journey saves before receipt, replays after restart and restricts each caller", async t => {
  const h = await harness(t);
  const initial = await h.engine.worlds.read(parent, WORLD_ID);
  const proposed = await h.engine.proposals.propose(parent, WORLD_ID, { ...draft, expectedRevision: initial.revision });
  assert.equal(proposed.revision, "1");
  assert.equal((await h.engine.worlds.read(child, WORLD_ID)).bundle.proposals.length, 0);
  await assert.rejects(h.engine.proposals.accept(child, WORLD_ID, proposed.value.proposal.id, { operationId: "accept" }), /Forbidden/);
  const accepted = await h.engine.proposals.accept(parent, WORLD_ID, proposed.value.proposal.id,
    { operationId: "accept", expectedDraftRevision: proposed.value.proposal.draftRevision });
  assert.equal(accepted.value.status, "accepted");
  const restarted = await h.restart();
  assert.deepEqual(await restarted.proposals.accept(parent, WORLD_ID, proposed.value.proposal.id,
    { operationId: "accept", expectedDraftRevision: proposed.value.proposal.draftRevision }), accepted);
  assert.equal(h.state.saves, 2);
  await assert.rejects(restarted.proposals.propose(parent, WORLD_ID, { ...draft, sentence: "Changed" }), /different input/);
  await assert.rejects(restarted.worlds.read({ ...parent, scopeId: "other" }, WORLD_ID), /Forbidden/);
  h.state.revoked = true;
  await assert.rejects(restarted.proposals.accept(parent, WORLD_ID, proposed.value.proposal.id, { operationId: "accept" }), /Forbidden/);
});

it("failed authoritative save and torn journal never grant permission to repeat a mutation", async t => {
  const h = await harness(t); h.state.failSave = true;
  await assert.rejects(h.engine.proposals.propose(parent, WORLD_ID, draft), /Authoritative/);
  const restarted = await h.restart(); h.state.failSave = false;
  await assert.rejects(restarted.proposals.propose(parent, WORLD_ID, draft), /uncertain outcome/);
  assert.equal(h.provider.openStore()!.getBundle().proposals.filter(p => p.proposal.summary.includes("Fenn")).length, 1);
  await appendFile(join(h.root, "operations.jsonl"), "{broken");
  const corrupt = new FileEngineOperationStore(join(h.root, "operations.jsonl"));
  await assert.rejects(corrupt.read(engineHash("missing")));
});

it("illustrations reuse the dispatcher, hold exact output and settle once after response loss", async t => {
  const h = await harness(t);
  const model = FAL_MODELS.find(m => m.capability === "image")!;
  assert.ok(model);
  const input = { operationId: "portrait", sheetId: "maren-kest", model, prompt: "Happy", count: 1,
    identityReferences: [], generationKey: "portrait" };
  h.state.refuse = true;
  await assert.rejects(h.engine.illustrations.generate(parent, WORLD_ID, input), /No allowance/);
  assert.equal(h.fake.submitCount, 0);
  h.state.refuse = false;
  const generated = await h.engine.illustrations.generate(parent, WORLD_ID, { ...input, operationId: "allowed" });
  await until(() => h.queue.listJobs().every(job => job.status === "succeeded"));
  assert.equal(h.fake.submitCount, 1);
  assert.ok((await readFile(join(h.root, "durable-jobs.jsonl"), "utf8")).includes(generated.jobIds[0]!));
  h.state.failSettlement = true;
  await assert.rejects(h.engine.illustrations.reconcile(parent, WORLD_ID, "allowed"), /Response lost/);
  const restarted = await h.restart(); h.state.failSettlement = false; h.state.held = true;
  await restarted.illustrations.reconcile(parent, WORLD_ID, "allowed");
  assert.equal(h.state.charges, 1); assert.equal(h.state.releases, 0);
  const file = "references/maren-kest/candidates/check.png";
  await mkdir(join(h.worldDir, "references/maren-kest/candidates"), { recursive: true });
  await writeFile(join(h.worldDir, file), pngBytes());
  await assert.rejects(restarted.worlds.media(child, WORLD_ID, file), /Held/);
  h.state.held = false;
  const first = await restarted.worlds.media(child, WORLD_ID, file);
  await writeFile(join(h.worldDir, file), new Uint8Array([...pngBytes(), 1]));
  const second = await restarted.worlds.media(child, WORLD_ID, file);
  assert.notEqual(first.sha256, second.sha256);
  await assert.rejects(restarted.worlds.media(child, WORLD_ID, "../../secret.png"));
});

it("concurrent duplicate calls join, stale revisions refuse, and close drains a delayed save", async t => {
  const h = await harness(t);
  const [one, two] = await Promise.all([h.engine.proposals.propose(parent, WORLD_ID, draft), h.engine.proposals.propose(parent, WORLD_ID, draft)]);
  assert.deepEqual(one, two); assert.equal(h.state.saves, 1);
  await assert.rejects(h.engine.proposals.discard(parent, WORLD_ID, one.value.proposal.id,
    { operationId: "stale-discard", expectedRevision: "stale" }), /changed/);
  const stale = await h.engine.proposals.accept(parent, WORLD_ID, one.value.proposal.id,
    { operationId: "stale-accept", expectedDraftRevision: 999 });
  assert.equal(stale.value.status, "stale");
  let resume!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { resume = resolve; });
  const original = h.policy.project;
  h.policy.project = async (...args) => { entered(); await wait; return original(...args); };
  const read = h.engine.worlds.read(parent, WORLD_ID);
  await started;
  let closed = false;
  const closing = h.engine.close().then(() => { closed = true; });
  await assert.rejects(h.engine.worlds.read(parent, WORLD_ID), /stopping/);
  assert.equal(closed, false);
  resume(); await read; await closing;
  assert.equal(closed, true);
});

it("loss of the local owner blocks writes without acknowledging a save", async t => {
  const h = await harness(t);
  const store = h.provider.openStore()!;
  await store.close();
  await assert.rejects(h.engine.proposals.propose(parent, WORLD_ID, draft), /unavailable|closed|lock/i);
  assert.equal(h.state.saves, 0);
});
