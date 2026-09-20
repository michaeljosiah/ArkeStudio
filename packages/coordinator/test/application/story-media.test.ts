import assert from "node:assert/strict";
import {it, type TestContext} from "node:test";
import {join} from "node:path";
import {createEngine, type EngineContext, type EnginePolicy} from "../../src/application/engine.js";
import {createLocalWorldRepository} from "../../src/application/local-worlds.js";
import {FileEngineOperationStore} from "../../src/application/local-operations.js";
import {FsWorldProvider} from "../../src/world/provider.js";
import {JobQueue} from "../../src/queue/dispatcher.js";
import {JobJournal} from "../../src/queue/journal.js";
import {makeTempRoot, WORLD_ID} from "../world/helpers.js";
import {FakeProvider, pngBytes, jpegBytes, webpBytes} from "../queue/fake-provider.js";
import {wav} from "../audio/helpers.js";
import {SHIPPED_MANIFEST} from "../../../providers/src/manifest-data.js";
import {until} from "../wait.js";

const context: EngineContext = {actorId: "parent", scopeId: "family", subjectId: "child", executorId: "host"};
const production = "the-ledger-of-nights", chapterId = "neap";
const image = SHIPPED_MANIFEST.models.find(m => m.capability === "image" && m.provider === "fal")!;
const speech = structuredClone(SHIPPED_MANIFEST.models.find(m => m.id === "eleven_multilingual_v2")!);
speech.limits.audioFormat = "wav";

async function harness(t: TestContext) {
  const {root, worldDir} = await makeTempRoot();
  const provider = new FsWorldProvider(root); await provider.loadWorld(WORLD_ID);
  const fake = new FakeProvider({supportsIdempotencyKey: true});
  const state = {boundGenerateOnly: false, audioType: "audio/wav", boundMediaOnly: false, revoked: false, held: false, charges: 0, releases: 0, hidden: false, loseAdmissionReply: false,
    hideJobs: false, failRelease: false, imageFormat: "png", extraImage: false, failSettlement: false, onReserve: async () => {}};
  const settled = new Set<string>();
  const released = new Set<string>();
  const submit = fake.submit.bind(fake);
  fake.submit = async (key, request) => {
    assert.equal("engineOperation" in request.params, false);
    fake.artifacts = request.params.audioFormat ? [{name: "audio.wav", contentType: state.audioType, data: wav([0, 1, 0, -1])}]
      : [{name: `page.${state.imageFormat}`, contentType: `image/${state.imageFormat}`,
        data: state.imageFormat === "jpeg" ? jpegBytes() : state.imageFormat === "webp" ? webpBytes() : pngBytes()}];
    if (state.extraImage) fake.artifacts.push({name: "output-2.png", contentType: "image/png", data: pngBytes()});
    return submit(key, request);
  };
  const policy: EnginePolicy = {
    async authorise(ctx, action, resource) {if (((state.boundMediaOnly && action === "media") || (state.boundGenerateOnly && action === "generate")) && (!resource.productionId || !resource.chapterId || !resource.sourceHash)) throw new Error("Chapter identity required"); if (state.revoked || ctx.scopeId !== "family" || ctx.subjectId !== "child") throw new Error("Forbidden");},
    async project(_ctx, bundle) {if (state.hidden) bundle.productions = []; return bundle;},
    async deliver(_ctx, _resource, content) {if (state.held && content.kind === "artifact") throw new Error("Held");},
    async reserve(_ctx, key) {await state.onReserve(); return key;}, async settle(_ctx, key) {
      if (!settled.has(key)) {state.charges++; settled.add(key);}
      if (state.failSettlement) throw new Error("Settlement reply lost");
    }, async release(_ctx, key) {if (!released.has(key)) {state.releases++; released.add(key);} if (state.failRelease) throw new Error("Release reply lost");},
  };
  const ledger = new Set<string>();
  const queue = new JobQueue({journal: new JobJournal(join(root, "jobs.jsonl")), journalPath: join(root, "unused.jsonl"),
    clients: {fal: fake, kokoro: fake, [speech.provider]: fake}, getKey: async () => "fake-key", emit() {},
    ledger: {readJobIds: async () => ledger, has: async id => ledger.has(id), append: async row => {ledger.add(row.jobId);}},
    landInWorld: async (_id, fn) => {await fn(worldDir); return true;}, pollIntervalMs: 5, baseIntervalMs: 1});
  await queue.start();
  const make = () => createEngine({worlds: createLocalWorldRepository(provider), operations: new FileEngineOperationStore(join(root, "operations.jsonl")),
    policy, queue: {enqueue: async input => {const job = await queue.enqueue(input); if (state.loseAdmissionReply) throw new Error("reply lost"); return job;},
      jobs: () => state.hideJobs ? [] : queue.listJobs(), cancel: id => queue.cancel(id)}});
  let engine = make();
  t.after(async () => {queue.stopAccepting(); queue.dispose(); await queue.drain(); await engine.close(); await provider.close();});
  const before = await engine.prose.readChapter(context, WORLD_ID, production, chapterId);
  await engine.prose.saveChapter(context, WORLD_ID, production, chapterId,
    {operationId: "fixture-prose", baseHash: before.hash, body: "The little robot planted a glowing flower beside the harbour."});
  const chapter = await engine.prose.readChapter(context, WORLD_ID, production, chapterId);
  return {engine, state, queue, chapter, fake, async restart() {await engine.close(); engine = make(); return engine;},
    async finished() {await until(() => queue.listJobs().every(j => ["succeeded", "failed"].includes(j.status)), "story media completion"); assert.ok(queue.listJobs().every(j => j.status === "succeeded"));}};
}

it("page artwork is durable, replayed once, review-gated and invalidated by a changed chapter", async t => {
  const h = await harness(t);
  const input = {operationId: "page", model: image, instruction: "A moonlit harbour", baseHash: h.chapter.hash};
  const first = await h.engine.storyMedia.illustratePage(context, WORLD_ID, production, chapterId, input);
  await h.finished();
  const restarted = await h.restart();
  assert.deepEqual(await restarted.storyMedia.illustratePage(context, WORLD_ID, production, chapterId, input), first);
  assert.equal(h.queue.listJobs().length, 1);
  h.state.held = true;
  assert.equal((await restarted.storyMedia.reconcile(context, WORLD_ID, "page")).status, "held");
  h.state.held = false;
  assert.equal((await restarted.storyMedia.reconcile(context, WORLD_ID, "page")).status, "settled");
  assert.equal(h.state.charges, 1);
  const artifact = h.queue.listJobs()[0]!.landedFiles![0]!;
  assert.equal((await restarted.worlds.media(context, WORLD_ID, artifact)).contentType, "image/png");
  await h.queue.delete(h.queue.listJobs()[0]!.id);
  assert.equal(h.queue.listJobs().length, 1, "source metadata survives an Activity deletion attempt");
  assert.equal((await restarted.worlds.media(context, WORLD_ID, artifact)).contentType, "image/png");
  await restarted.prose.saveChapter(context, WORLD_ID, production, chapterId, {operationId: "edit", baseHash: h.chapter.hash, body: "A different story."});
  await assert.rejects(restarted.worlds.media(context, WORLD_ID, artifact), /chapter changed/);
  await assert.rejects(restarted.worlds.media(context, WORLD_ID, artifact.replaceAll("/", "\\")), /chapter changed/);
  await assert.rejects(restarted.worlds.media(context, WORLD_ID, artifact.toUpperCase()), /unavailable or ambiguous/);
  assert.deepEqual((await restarted.illustrations.reconcile(context, WORLD_ID, "page")).deliverableJobIds, []);
});

it("an uncertain admission retains the original job across restart without a second submission", async t => {
  const h = await harness(t); h.state.loseAdmissionReply = true;
  const input = {operationId: "lost-reply", model: image, instruction: "A harbour", baseHash: h.chapter.hash};
  const first = await h.engine.storyMedia.illustratePage(context, WORLD_ID, production, chapterId, input);
  assert.equal(first.needsReconciliation, true);
  await h.finished();
  const engine = await h.restart();
  h.state.loseAdmissionReply = false;
  assert.deepEqual(await engine.storyMedia.illustratePage(context, WORLD_ID, production, chapterId, input), first);
  assert.equal(h.queue.listJobs().length, 1);
  assert.equal((await engine.storyMedia.reconcile(context, WORLD_ID, "lost-reply")).status, "needs-reconciliation");
  await assert.rejects(engine.storyMedia.cancel(context, WORLD_ID, "lost-reply"), /Admission is uncertain/);
  assert.equal(h.state.charges, 0);
});

for (const format of ["jpeg", "webp"]) it(`page artwork retains verified ${format} format`, async t => {
  const h = await harness(t); h.state.imageFormat = format;
  await h.engine.storyMedia.illustratePage(context, WORLD_ID, production, chapterId,
    {operationId: "format", model: image, instruction: "A harbour", baseHash: h.chapter.hash});
  await h.finished();
  const artifact = h.queue.listJobs()[0]!.landedFiles![0]!;
  assert.match(artifact, format === "jpeg" ? /\.jpg$/ : /\.webp$/);
  assert.equal((await h.engine.worlds.media(context, WORLD_ID, artifact)).contentType, `image/${format}`);
});

it("releases an unused reservation when the source changes during reservation", async t => {
  const h = await harness(t);
  h.state.onReserve = async () => {
    await h.engine.prose.saveChapter(context, WORLD_ID, production, chapterId,
      {operationId: "concurrent-edit", baseHash: h.chapter.hash, body: "Changed while reserving."});
  };
  await assert.rejects(h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId,
    {operationId: "changed", model: speech, voiceId: "stock", baseHash: h.chapter.hash}), /chapter changed/);
  assert.equal(h.queue.listJobs().length, 0);
  assert.equal(h.state.releases, 1);
});

it("bounds narration even when the model has no declared prompt limit", async t => {
  const h = await harness(t);
  const saved = await h.engine.prose.saveChapter(context, WORLD_ID, production, chapterId,
    {operationId: "long", baseHash: h.chapter.hash, body: "a".repeat(1001)});
  const model = structuredClone(speech); delete model.limits.maxPromptChars;
  await assert.rejects(h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId,
    {operationId: "unbounded", model, voiceId: "stock", baseHash: saved.value.hash}), /will not be truncated/);
  assert.equal(h.queue.listJobs().length, 0);
});

it("cancellation uses the host queue and never grants another family authority", async t => {
  const h = await harness(t); h.fake.pollState = "running";
  await h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId,
    {operationId: "cancel", model: {...speech, provider: "kokoro"}, voiceId: "stock", baseHash: h.chapter.hash});
  await until(() => h.queue.listJobs().some(j => j.status === "running"), "running narration");
  assert.equal(h.queue.listJobs()[0]!.target.kind, "story-chapter-narration");
  await assert.rejects(h.engine.storyMedia.cancel({...context, scopeId: "other"}, WORLD_ID, "cancel"), /not found for this caller/);
  assert.equal((await h.engine.storyMedia.cancel(context, WORLD_ID, "cancel")).needsReconciliation, false);
  assert.equal(h.queue.listJobs()[0]!.status, "cancelled");
  await h.engine.prose.saveChapter(context, WORLD_ID, production, chapterId,
    {operationId: "edit-after-cancel", baseHash: h.chapter.hash, body: "The next version."});
  assert.equal((await h.engine.storyMedia.reconcile(context, WORLD_ID, "cancel")).status, "settled");
  assert.equal(h.state.charges, 0);
  assert.equal(h.state.releases, 1);
});

it("retains an uncertain remote cancellation and its reservation after restart", async t => {
  const h = await harness(t); h.fake.pollState = "running";
  h.fake.cancel = async () => {throw new Error("Provider cancellation unavailable");};
  await h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId,
    {operationId: "remote-cancel", model: speech, voiceId: "stock", baseHash: h.chapter.hash});
  await until(() => h.queue.listJobs().some(job => job.status === "running"), "remote narration admission");
  assert.equal((await h.engine.storyMedia.cancel(context, WORLD_ID, "remote-cancel")).needsReconciliation, true);
  assert.equal(h.queue.listJobs()[0]!.cancellationUncertain, true);
  const engine = await h.restart();
  assert.equal((await engine.storyMedia.reconcile(context, WORLD_ID, "remote-cancel")).status, "needs-reconciliation");
  assert.equal(h.state.releases, 0);
});

it("reports stale successful output as held without delivering or charging it", async t => {
  const h = await harness(t);
  await h.engine.storyMedia.illustratePage(context, WORLD_ID, production, chapterId,
    {operationId: "stale-success", model: image, instruction: "A harbour", baseHash: h.chapter.hash});
  await h.finished();
  await h.engine.prose.saveChapter(context, WORLD_ID, production, chapterId,
    {operationId: "edit-before-settlement", baseHash: h.chapter.hash, body: "Edited before first review."});
  assert.equal((await h.engine.storyMedia.reconcile(context, WORLD_ID, "stale-success")).status, "held");
  assert.equal(h.state.charges, 0);
  assert.equal(h.state.releases, 0);
});

it("secondary provider artifacts keep the same chapter source binding", async t => {
  const h = await harness(t); h.state.extraImage = true;
  await h.engine.storyMedia.illustratePage(context, WORLD_ID, production, chapterId,
    {operationId: "multiple", model: image, instruction: "A harbour", baseHash: h.chapter.hash});
  await h.finished();
  const secondary = h.queue.listJobs()[0]!.landedFiles![1]!;
  assert.ok(secondary.endsWith("output-2.png"));
  await h.engine.storyMedia.illustratePage(context, WORLD_ID, production, chapterId,
    {operationId: "another-multiple", model: image, instruction: "Another harbour", baseHash: h.chapter.hash});
  await h.finished();
  assert.notEqual(h.queue.listJobs()[1]!.landedFiles![1], secondary);
  await h.engine.worlds.media(context, WORLD_ID, secondary);
  await h.engine.prose.saveChapter(context, WORLD_ID, production, chapterId,
    {operationId: "edit-secondary", baseHash: h.chapter.hash, body: "Changed story."});
  await assert.rejects(h.engine.worlds.media(context, WORLD_ID, secondary), /chapter changed/);
});

it("resumes a recorded settlement after a source edit without delivering stale output", async t => {
  const h = await harness(t);
  await h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId,
    {operationId: "settle-retry", model: speech, voiceId: "stock", baseHash: h.chapter.hash});
  await h.finished(); h.state.failSettlement = true;
  await assert.rejects(h.engine.storyMedia.reconcile(context, WORLD_ID, "settle-retry"), /Settlement reply lost/);
  await h.engine.prose.saveChapter(context, WORLD_ID, production, chapterId,
    {operationId: "edit-settlement", baseHash: h.chapter.hash, body: "Changed after the financial decision."});
  const engine = await h.restart(); h.state.failSettlement = false;
  const result = await engine.storyMedia.reconcile(context, WORLD_ID, "settle-retry");
  assert.equal(result.status, "settled");
  assert.deepEqual(result.deliverableJobIds, []);
  assert.equal(h.state.charges, 1);
});

it("refuses narration that returns a different format before landing it", async t => {
  const h = await harness(t);
  await h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId,
    {operationId: "wrong-format", model: {...speech, limits: {...speech.limits, audioFormat: "mp3"}}, voiceId: "stock", baseHash: h.chapter.hash});
  await until(() => h.queue.listJobs().every(job => job.status === "failed"), "mismatched narration rejection");
  assert.equal(h.queue.listJobs()[0]!.landedFiles?.length ?? 0, 0);
  assert.equal((await h.engine.storyMedia.reconcile(context, WORLD_ID, "wrong-format")).status, "settled");
  assert.equal(h.state.releases, 1);
});

it("narration lands complete audio through the same queue and survives a restart", async t => {
  const h = await harness(t);
  const input = {operationId: "voice", model: speech, voiceId: "stock-voice", baseHash: h.chapter.hash};
  const first = await h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId, input);
  await h.finished();
  const engine = await h.restart();
  assert.deepEqual(await engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId, input), first);
  assert.equal((await engine.storyMedia.reconcile(context, WORLD_ID, "voice")).status, "settled");
  assert.equal((await engine.worlds.media(context, WORLD_ID, h.queue.listJobs()[0]!.landedFiles![0]!)).contentType, "audio/wav");
});

it("refuses stale, hidden, unauthorized and oversized sources before queue admission", async t => {
  const h = await harness(t);
  const input = {operationId: "voice", model: speech, voiceId: "stock", baseHash: h.chapter.hash};
  await assert.rejects(h.engine.storyMedia.narrateChapter({...context, scopeId: "other"}, WORLD_ID, production, chapterId, input), /Forbidden/);
  await assert.rejects(h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId, {...input, baseHash: `sha256:${"0".repeat(64)}`}), /chapter changed/);
  h.state.hidden = true;
  await assert.rejects(h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId, input), /visible production/);
  h.state.hidden = false;
  await assert.rejects(h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId,
    {...input, model: {...speech, limits: {...speech.limits, maxPromptChars: 1}}}), /will not be truncated/);
  assert.equal(h.queue.listJobs().length, 0);
});

it("refuses known cloned-reference narration models before reserving or enqueueing", async t => {
  const h = await harness(t);
  let reservations = 0; h.state.onReserve = async () => {reservations++;};
  for (const model of SHIPPED_MANIFEST.models.filter(m => m.id === "comfyui-cloned-voice")) {
    await assert.rejects(h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId,
      {operationId: model.id, model, voiceId: "stock", baseHash: h.chapter.hash}), /stock-voice model/);
  }
  assert.equal(reservations, 0);
  assert.equal(h.queue.listJobs().length, 0);
});

it("allows a dual-mode provider's stock voice while refusing unsupported image tiers", async t => {
  const h = await harness(t);
  const model = SHIPPED_MANIFEST.models.find(m => m.id === "voxtral-mini-tts")!;
  const result = await h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId,
    {operationId: "stock-reader", model, voiceId: "preset", baseHash: h.chapter.hash});
  assert.equal(result.jobIds.length, 1);
  await assert.rejects(h.engine.storyMedia.illustratePage(context, WORLD_ID, production, chapterId,
    {operationId: "unsupported-tier", model: {...image, limits: {resolutions: ["1K"], tiers: {"1K": "1K"}}},
      instruction: "A harbour", tier: "4K", baseHash: h.chapter.hash}), /page size tier/);
  assert.equal(h.queue.listJobs().length, 1);
});


it("cancellation retains recorded job identities when queue evidence is missing", async t => {
  const h = await harness(t);
  const receipt = await h.engine.storyMedia.illustratePage(context, WORLD_ID, production, chapterId,
    {operationId: "missing-row", model: image, instruction: "Harbour", baseHash: h.chapter.hash});
  await h.finished(); h.state.hideJobs = true;
  const result = await h.engine.storyMedia.cancel(context, WORLD_ID, "missing-row");
  assert.deepEqual(result.jobIds, receipt.jobIds);
  assert.equal(result.needsReconciliation, true);
  assert.equal(h.state.releases, 0);
});

it("bounds complete image prompts even without a model limit", async t => {
  const h = await harness(t);
  const saved = await h.engine.prose.saveChapter(context, WORLD_ID, production, chapterId,
    {operationId: "long-image", baseHash: h.chapter.hash, body: "a".repeat(8001)});
  const model = structuredClone(image); delete model.limits.maxPromptChars;
  await assert.rejects(h.engine.storyMedia.illustratePage(context, WORLD_ID, production, chapterId,
    {operationId: "bounded-image", model, instruction: "Harbour", baseHash: saved.value.hash}), /prompt limit/);
  assert.equal(h.queue.listJobs().length, 0);
});

it("resumes a zero-job release after its response is lost and the engine restarts", async t => {
  const h = await harness(t); h.state.failRelease = true;
  h.state.onReserve = async () => {
    await h.engine.prose.saveChapter(context, WORLD_ID, production, chapterId,
      {operationId: "release-edit", baseHash: h.chapter.hash, body: "Changed while reserving."});
  };
  await assert.rejects(h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId,
    {operationId: "lost-release", model: speech, voiceId: "stock", baseHash: h.chapter.hash}), /Release reply lost/);
  const engine = await h.restart(); h.state.failRelease = false;
  assert.equal((await engine.storyMedia.reconcile(context, WORLD_ID, "lost-release")).status, "settled");
  assert.equal((await engine.storyMedia.reconcile(context, WORLD_ID, "lost-release")).status, "settled");
  assert.equal(h.state.releases, 1);
  assert.equal(h.queue.listJobs().length, 0);
});

for (const kind of ["settle", "release"] as const) it(`resumes a saved ${kind} after revocation without delivering media`, async t => {
  const h = await harness(t);
  if (kind === "release") {
    h.state.failRelease = true;
    h.state.onReserve = async () => {h.state.revoked = true;};
    await assert.rejects(h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId,
      {operationId: "revoked-recovery", model: speech, voiceId: "stock", baseHash: h.chapter.hash}), /Release reply lost/);
    h.state.failRelease = false;
  } else {
    await h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId,
      {operationId: "revoked-recovery", model: speech, voiceId: "stock", baseHash: h.chapter.hash});
    await h.finished(); h.state.failSettlement = true;
    await assert.rejects(h.engine.storyMedia.reconcile(context, WORLD_ID, "revoked-recovery"), /Settlement reply lost/);
    h.state.failSettlement = false; h.state.revoked = true;
  }
  const engine = await h.restart();
  await assert.rejects(engine.storyMedia.reconcile({...context, subjectId: "other-child"}, WORLD_ID, "revoked-recovery"));
  for (let i = 0; i < 2; i++) {
    const result = await engine.storyMedia.reconcile(context, WORLD_ID, "revoked-recovery");
    assert.equal(result.status, "settled"); assert.deepEqual(result.deliverableJobIds, []);
  }
  assert.equal(h.state.charges, kind === "settle" ? 1 : 0);
  assert.equal(h.state.releases, kind === "release" ? 1 : 0);
});

it("authorises story media with its chapter identity before reading bytes", async t => {
  const h = await harness(t);
  await h.engine.storyMedia.illustratePage(context, WORLD_ID, production, chapterId,
    {operationId: "bound-media", model: image, instruction: "A harbour", baseHash: h.chapter.hash});
  await h.finished(); h.state.boundMediaOnly = true;
  const artifact = h.queue.listJobs()[0]!.landedFiles![0]!;
  assert.equal((await h.engine.worlds.media(context, WORLD_ID, artifact)).contentType, "image/png");
  assert.equal((await h.engine.storyMedia.reconcile(context, WORLD_ID, "bound-media")).status, "settled");
  assert.equal(h.state.charges, 1);
});

it("cancels under chapter-scoped authority without a broad world grant", async t => {
  const h = await harness(t); h.state.boundGenerateOnly = true; h.fake.pollState = "running";
  await h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId,
    {operationId: "scoped-cancel", model: speech, voiceId: "stock", baseHash: h.chapter.hash});
  await until(() => h.queue.listJobs().some(job => job.status === "running"), "running narration");
  await h.engine.storyMedia.cancel(context, WORLD_ID, "scoped-cancel");
  assert.equal(h.queue.listJobs()[0]!.status, "cancelled");
});

it("accepts verified WAV bytes with an equivalent provider MIME label", async t => {
  const h = await harness(t); h.state.audioType = "audio/x-wav";
  await h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId,
    {operationId: "wav-alias", model: speech, voiceId: "stock", baseHash: h.chapter.hash});
  await h.finished();
  assert.equal((await h.engine.storyMedia.reconcile(context, WORLD_ID, "wav-alias")).status, "settled");
});

it("releases a provider-confirmed cancellation after restart", async t => {
  const h = await harness(t); h.fake.pollState = "cancelled";
  await h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId,
    {operationId: "provider-cancel", model: speech, voiceId: "stock", baseHash: h.chapter.hash});
  await until(() => h.queue.listJobs()[0]?.status === "cancelled", "provider cancellation");
  assert.equal(h.queue.listJobs()[0]!.cancellationUncertain, false);
  const engine = await h.restart();
  assert.equal((await engine.storyMedia.reconcile(context, WORLD_ID, "provider-cancel")).status, "settled");
  assert.equal(h.state.releases, 1); assert.equal(h.state.charges, 0);
});


it("rejects unsupported speech pricing before recording admission", async t => {
  const h = await harness(t);
  const input = {operationId: "pricing", model: {...speech, pricing: {kind: "perSecond" as const, microUsdPerSecond: 100}}, voiceId: "stock", baseHash: h.chapter.hash};
  await assert.rejects(h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId, input), /pricing/);
  await assert.rejects(h.engine.storyMedia.reconcile(context, WORLD_ID, "pricing"), /not found/);
  assert.equal(h.queue.listJobs().length, 0);
  await h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId, {...input, model: speech});
  await h.finished();
});

it("invalid page and narration limits leave no admission to reconcile", async t => {
  const h = await harness(t);
  await assert.rejects(h.engine.storyMedia.illustratePage(context, WORLD_ID, production, chapterId,
    {operationId: "invalid-page", model: {...image, limits: {...image.limits, maxPromptChars: 1}}, instruction: "A harbour", baseHash: h.chapter.hash}), /prompt limit/);
  await assert.rejects(h.engine.storyMedia.reconcile(context, WORLD_ID, "invalid-page"), /not found/);
  await assert.rejects(h.engine.storyMedia.narrateChapter(context, WORLD_ID, production, chapterId,
    {operationId: "invalid-speech", model: {...speech, limits: {...speech.limits, maxPromptChars: 1}}, voiceId: "stock", baseHash: h.chapter.hash}), /will not be truncated/);
  await assert.rejects(h.engine.storyMedia.reconcile(context, WORLD_ID, "invalid-speech"), /not found/);
  assert.equal(h.queue.listJobs().length, 0);
});
