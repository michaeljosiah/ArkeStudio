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
  const submit = fake.submit.bind(fake);
  fake.submit = async (key, request) => {
    assert.equal("engineOperation" in request.params, false, "host identity and reservation stay out of provider parameters");
    return submit(key, request);
  };
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
    clients: { fal: fake }, getKey: async (_provider, job) => {
      const owner = job.params.engineOperation as { context: EngineContext };
      assert.deepEqual(owner.context, parent); return "scoped-test-key";
    }, emit() {},
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
  const rows = (await readFile(join(h.root, "operations.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.find(row => row.action === "propose").context, parent);
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
  await until(() => h.queue.listJobs().every(job => job.status === "succeeded"), "portrait completion");
  assert.equal(h.fake.submitCount, 1);
  assert.ok((await readFile(join(h.root, "durable-jobs.jsonl"), "utf8")).includes(generated.jobIds[0]!));
  h.state.held = true;
  assert.equal((await h.engine.illustrations.reconcile(parent, WORLD_ID, "allowed")).status, "held");
  assert.equal(h.state.charges + h.state.releases, 0);
  h.state.held = false;
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
  const originalDelivery = h.policy.deliver;
  h.policy.deliver = async (context, resource, content) => {
    await originalDelivery(context, resource, content);
    if (content.kind === "artifact" && content.sha256 !== first.sha256) throw new Error("Changed output needs review");
  };
  await assert.rejects(restarted.worlds.media(child, WORLD_ID, file), /Changed output/);
  h.policy.deliver = originalDelivery;
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
  const lock = join(h.worldDir, "world.lock");
  const successor = { pid: process.pid, startedAt: "2000-01-01T00:00:00.000Z" };
  await writeFile(lock, JSON.stringify(successor));
  await assert.rejects(h.engine.proposals.propose(parent, WORLD_ID, draft), /ownership lost/);
  assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), successor);
  await assert.rejects(h.provider.close(), /ownership lost/);
  assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), successor);
  assert.equal(h.state.saves, 0);
});


it("an enqueue response lost after durable admission cannot blindly submit again", async t => {
  const h = await harness(t);
  const enqueue = h.queue.enqueue.bind(h.queue);
  h.queue.enqueue = async input => { await enqueue(input); throw new Error("Lost enqueue receipt"); };
  const input = { operationId: "uncertain-image", sheetId: "maren-kest", model: FAL_MODELS[0]!, prompt: "Happy",
    count: 1, identityReferences: [], generationKey: "image" };
  const partial = await h.engine.illustrations.generate(parent, WORLD_ID, input);
  assert.equal(partial.needsReconciliation, true);
  assert.equal(partial.jobIds.length, 1);
  h.queue.enqueue = enqueue;
  await until(() => h.queue.listJobs().every(job => job.status === "succeeded"), "uncertain admitted job completion");
  const restarted = await h.restart();
  assert.deepEqual(await restarted.illustrations.generate(parent, WORLD_ID, input), partial);
  assert.equal((await restarted.illustrations.reconcile(parent, WORLD_ID, input.operationId)).status, "needs-reconciliation");
  assert.equal(h.fake.submitCount, 1);
  assert.equal(h.state.charges + h.state.releases, 0);
});

it("a background authoring call uses its named world while Studio has another world selected", async t => {
  const h = await harness(t);
  const other = await h.provider.createWorld({ name: "Another world" });
  await h.provider.loadWorld(other.worldId);
  const proposed = await h.engine.proposals.propose(parent, WORLD_ID, draft);
  assert.equal(h.provider.openStore()!.worldId, other.worldId);
  assert.equal(h.provider.openStore()!.getBundle().proposals.some(p => p.proposal.id === proposed.value.proposal.id), false);
  const owner = await h.engine.worlds.read(parent, WORLD_ID);
  assert.ok(owner.bundle.proposals.some(p => p.proposal.id === proposed.value.proposal.id));
  assert.equal(h.provider.openStore()!.worldId, other.worldId);
});


it("reconciliation retains the original subject and rechecks the recorded sheet authority", async t => {
  const h = await harness(t);
  await h.engine.illustrations.generate(parent, WORLD_ID, { operationId: "scoped-image", sheetId: "maren-kest",
    model: FAL_MODELS[0]!, prompt: "Happy", count: 1, identityReferences: [], generationKey: "image" });
  await until(() => h.queue.listJobs().every(job => job.status === "succeeded"), "scoped image completion");
  await assert.rejects(h.engine.illustrations.reconcile({ ...parent, subjectId: "another-child" }, WORLD_ID, "scoped-image"), /different caller or subject/);
  await assert.rejects(h.engine.operation({ ...parent, subjectId: "another-child" }, WORLD_ID, "scoped-image"), /different caller or subject/);
  const authorise = h.policy.authorise;
  h.policy.authorise = async (context, action, resource) => {
    await authorise(context, action, resource);
    if (resource.sheetId === "maren-kest") throw new Error("Sheet access revoked");
  };
  await assert.rejects(h.engine.illustrations.reconcile(parent, WORLD_ID, "scoped-image"), /Sheet access revoked/);
  assert.equal(h.state.charges + h.state.releases, 0);
});

it("partial batches retain admitted job IDs on the first response and after restart", async t => {
  const h = await harness(t);
  const enqueue = h.queue.enqueue.bind(h.queue);
  let calls = 0;
  h.queue.enqueue = async input => { if (++calls === 2) throw new Error("Admission unavailable"); return enqueue(input); };
  const input = { operationId: "partial-image", sheetId: "maren-kest", model: FAL_MODELS[0]!, prompt: "Happy",
    count: 3, identityReferences: [], generationKey: "image" };
  const partial = await h.engine.illustrations.generate(parent, WORLD_ID, input);
  assert.equal(partial.needsReconciliation, true);
  assert.deepEqual(partial.jobIds, h.queue.listJobs().map(job => job.id));
  assert.equal(partial.jobIds.length, 1);
  assert.deepEqual(partial.failures.map(failure => failure.index), [1, 2]);
  await until(() => h.queue.listJobs().every(job => job.status === "succeeded"), "partially admitted portrait");
  const restarted = await h.restart();
  assert.deepEqual(await restarted.illustrations.generate(parent, WORLD_ID, input), partial);
  assert.equal(h.fake.submitCount, 1);
  assert.equal((await restarted.illustrations.reconcile(parent, WORLD_ID, input.operationId)).status, "needs-reconciliation");
  assert.equal(h.state.charges + h.state.releases, 0);
});
