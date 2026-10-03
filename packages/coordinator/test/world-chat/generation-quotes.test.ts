import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { newId, type ConversationActionCard, type LedgerEntry, type ManifestModel, type ModelManifest, type ModelWorldChatAction } from "@arke-studio/contracts";
import { GenerationQuotes } from "../../src/world-chat/generation-quotes.js";
import { imageGenerationSource } from "../../src/world-chat/image-generation.js";
import { WorldStore } from "../../src/world/store.js";
import { JobQueue } from "../../src/queue/dispatcher.js";
import { readContainedImageReferences } from "../../src/world/reference-files.js";
import { stagedReferenceDir } from "../../src/references/master-look.js";
import { recordReferenceTake } from "../../src/references/takes.js";
import { createProp, addPropState } from "../../src/references/props.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempWorld } from "../world/helpers.js";
import { FakeProvider, jpegBytes, pngBytes, webpBytes } from "../queue/fake-provider.js";
import { until } from "../wait.js";

const AT = "2026-10-03T12:00:00.000Z";
const MODEL: ManifestModel = { id: "test-image", provider: "fal", capability: "image", displayName: "Test Image",
  accepts: { referenceImages: 4, startFrame: false, endFrame: false }, limits: {}, pricing: { kind: "perImage", microUsdPerImage: 40_000 } };
const mainPhoto = (count = 1): ModelWorldChatAction => ({ kind: "reference-generation", modelId: MODEL.id,
  request: { operation: "main-photo", sheetId: "maren-kest", prompt: "Salt-lit portrait", count, identityReferenceIds: [] }, checkReceiptIds: [newId("check")] });

async function setup(beforeOpen?: (dir: string) => Promise<void>) {
  const dir = await makeTempWorld();
  await beforeOpen?.(dir);
  let now = AT;
  const store = await WorldStore.open(dir, { clock: () => now });
  closeOnCleanup(() => store.close());
  const manifest: ModelManifest = { manifestVersion: 1, generated: "2026-10-03", models: [structuredClone(MODEL)] };
  const source = imageGenerationSource(store, { manifest, settings: async () => null, freeze: input => input });
  const fake = new FakeProvider({ supportsIdempotencyKey: true, supportsLookupByKey: true });
  fake.inlineArtifacts = [{ name: "image.png", contentType: "image/png", data: pngBytes() }];
  const ledger: LedgerEntry[] = [];
  const queue = new JobQueue({ journalPath: join(dir, "test-jobs.jsonl"), clients: { fal: fake }, getKey: async () => "test-key", emit: () => {},
    ledger: { readJobIds: async () => new Set(ledger.map(entry => entry.jobId)), has: async id => ledger.some(entry => entry.jobId === id), append: async entry => { ledger.push(entry); } },
    landInWorld: async (_id, land) => { await store.ownedWrite(() => land(dir)); return true; },
    onProviderFault: () => {}, readImageReferences: (_id, paths) => readContainedImageReferences(dir, paths),
    onTerminal: async job => { if (job.status === "succeeded") await recordReferenceTake(store, job, ledger.find(entry => entry.jobId === job.id)); },
    baseIntervalMs: 1, pollIntervalMs: 5,
  });
  closeOnCleanup(() => queue.dispose());
  await queue.start();
  const ports = { enqueue: input => queue.enqueue(input), jobs: () => queue.listJobs() } satisfies ConstructorParameters<typeof GenerationQuotes>[2];
  const quotes = () => new GenerationQuotes(store, source, ports);
  return { dir, store, manifest, fake, queue, quotes, source, setNow: (at: string) => { now = at; } };
}

describe("durable generation quotes (SPEC-050 R-11..20)", () => {
  it("prepares without jobs, survives restart, and makes one unselected main photo exactly once", async () => {
    const h = await setup();
    const action = mainPhoto();
    const id = newId("act");
    const body = await h.quotes().prepare(action, id, AT);
    assert.equal(body.estimatedMicroUsd, 40_000);
    assert.match(body.prompt, /Salt-lit portrait/);
    assert.equal(h.queue.listJobs().length, 0);
    assert.equal(h.fake.submitCount, 0);
    assert.deepEqual(await h.quotes().prepare(action, id, AT), body, "a fresh service reads the exact persisted quote");
    const before = structuredClone(h.store.getBundle().referenceKits.find(kit => kit.sheetId === "maren-kest"));
    assert.equal((await h.quotes().dispatch(action, id)).status, "queued");
    await h.quotes().dispatch(action, id);
    await until(() => h.queue.listJobs()[0]?.finalization?.status === "complete", "reference to finalize", 30_000);
    await h.store.reload();
    assert.equal(h.fake.submitCount, 1);
    assert.equal(h.queue.listJobs().length, 1);
    const take = h.store.getBundle().referenceTakes.find(take => take.jobId === h.queue.listJobs()[0]!.id);
    assert.ok(take?.media, "the normal reference finalization creates an immutable pending take");
    assert.deepEqual(h.store.getBundle().referenceKits.find(kit => kit.sheetId === "maren-kest"), before, "generation does not adopt or replace the accepted photo");
    assert.equal(h.store.getBundle().referenceReviews.some(review => review.takeId === take.id), false);
  });

  it("refuses changed pricing, request quantity, quote inputs and expiry before any provider call", async () => {
    const h = await setup();
    const action = mainPhoto();
    const id = newId("act");
    await h.quotes().prepare(action, id, AT);
    h.manifest.models[0]!.pricing = { kind: "perImage", microUsdPerImage: 80_000 };
    await assert.rejects(h.quotes().dispatch(action, id), /changed/);
    h.manifest.models[0]!.pricing = MODEL.pricing;
    await assert.rejects(h.quotes().dispatch(mainPhoto(2), id), /unavailable/);
    const path = join(h.dir, ".history/world/prepared", `${id}.generation.json`);
    const record = JSON.parse(await readFile(path, "utf8"));
    record.inputs[0].params.prompt = "A different purchase";
    await writeFile(path, JSON.stringify(record));
    await assert.rejects(h.quotes().dispatch(action, id), /unavailable/);
    const fresh = newId("act");
    await h.quotes().prepare(action, fresh, AT);
    h.setNow("2026-10-03T12:15:00.000Z");
    await assert.rejects(h.quotes().dispatch(action, fresh), /expired/);
    assert.equal(h.fake.submitCount, 0);
    assert.equal(h.queue.listJobs().length, 0);
  });

  it("refuses changed reference bytes at approval and again at provider dispatch", async () => {
    const h = await setup();
    const action: ModelWorldChatAction = { kind: "reference-generation", modelId: MODEL.id,
      request: { operation: "character-sheet", sheetId: "maren-kest" }, checkReceiptIds: [newId("check")] };
    const id = newId("act");
    const body = await h.quotes().prepare(action, id, AT);
    assert.equal(body.references.length, 1);
    const path = join(h.dir, "references/maren-kest/head-front.png");
    const original = await readFile(path);
    await writeFile(path, pngBytes());
    await assert.rejects(h.quotes().dispatch(action, id), /changed/);
    await writeFile(path, original);
    const input = (await h.quotes().validate(action, id)).inputs[0]!;
    await writeFile(path, pngBytes());
    const job = await h.queue.enqueue(input);
    await until(() => h.queue.listJobs().find(one => one.id === job.id)?.status === "failed", "changed reference to refuse", 30_000);
    assert.equal(h.fake.submitCount, 0);
    assert.match(h.queue.listJobs()[0]!.error!, /changed after generation approval/);
  });

  it("quotes the matching default, retains zero-cost approval, and denying abandons without jobs", async () => {
    const h = await setup();
    h.manifest.models[0]!.pricing = { kind: "unmetered" };
    const action = mainPhoto();
    delete (action as Extract<ModelWorldChatAction, { kind: "reference-generation" }>).modelId;
    const id = newId("act");
    const body = await h.quotes().prepare(action, id, AT);
    assert.equal(body.cost, "No provider charge");
    assert.equal(body.estimatedMicroUsd, 0);
    assert.match(body.options![0]!.value, /default/);
    await h.quotes().abandon(id);
    await assert.rejects(h.quotes().validate(action, id), /unavailable/);
    assert.equal(h.queue.listJobs().length, 0);
  });

  it("never retries an interrupted admission when a fresh service rejoins the authorization", async () => {
    const h = await setup();
    let admissions = 0;
    const ports = { enqueue: async () => { admissions++; throw new Error("Uncertain append"); }, jobs: () => [] };
    const quotes = () => new GenerationQuotes(h.store, h.source, ports);
    const action = mainPhoto(2);
    const id = newId("act");
    await quotes().prepare(action, id, AT);
    assert.equal((await quotes().dispatch(action, id)).status, "running");
    await quotes().dispatch(action, id);
    assert.equal(admissions, 1);
    const outcome = await quotes().reconcile({ actionId: id } as ConversationActionCard);
    assert.equal(outcome?.receipt?.generation?.actualMicroUsd, null);
    assert.match(outcome!.receipt!.summary, /interrupted/);
  });

  it("files a generated prop-state candidate as a pending take without accepting it", async () => {
    const h = await setup();
    const prop = (await createProp(h.store, "Tide sword"))!;
    const state = (await addPropState(h.store, prop.id, "Broken"))!;
    const action: ModelWorldChatAction = { kind: "image-generation", modelId: MODEL.id, request: { operation: "prop-state", propId: prop.id, stateId: state.id, prompt: "Broken at the hilt", count: 1 }, checkReceiptIds: [newId("check")] };
    const id = newId("act");
    await h.quotes().prepare(action, id, AT);
    await h.quotes().dispatch(action, id);
    await until(() => h.queue.listJobs()[0]?.finalization?.status === "complete", "prop candidate to finalize", 30_000);
    await h.store.reload();
    assert.ok(h.store.getBundle().referenceTakes.some(take => take.kind === "prop-state" && take.prop?.stateId === state.id));
    assert.equal(h.store.getBundle().props.find(one => one.id === prop.id)!.states[0]!.reference, undefined);
  });

  it("quotes every existing kit compiler and the two world image surfaces without dispatching", async () => {
    const h = await setup();
    const requests: Array<Extract<ModelWorldChatAction, { kind: "reference-generation" }>["request"]> = [
      { operation: "main-photo", sheetId: "maren-kest", prompt: "Portrait", count: 2, identityReferenceIds: [] },
      { operation: "character-sheet", sheetId: "maren-kest" },
      { operation: "character-looks", sheetId: "maren-kest", lookKind: "costume", mode: "stay-close", prompt: "Blue jacket", count: 2 },
      { operation: "establish-look", sheetId: "maren-kest", count: 2 },
      { operation: "location-view", sheetId: "the-vigil", name: "Establishing", count: 1, establishing: true },
      { operation: "missing-tiles", sheetId: "maren-kest", group: "head" },
      { operation: "regenerate-tile", sheetId: "maren-kest", angle: "head-front" },
    ];
    for (const request of requests) {
      const body = await h.quotes().prepare({ kind: "reference-generation", modelId: MODEL.id, request, checkReceiptIds: [newId("check")] }, newId("act"), AT);
      assert.equal(body.estimatedMicroUsd, body.quantity * 40_000, request.operation);
      assert.equal(body.provider, "fal");
      assert.match(body.output, /separate card/);
    }
    for (const operation of ["world-image", "master-look"] as const) {
      const body = await h.quotes().prepare({ kind: "image-generation", modelId: MODEL.id, request: { operation, count: 2 }, checkReceiptIds: [newId("check")] }, newId("act"), AT);
      assert.equal(body.quantity, 2);
      assert.equal(body.estimatedMicroUsd, 80_000);
    }
    assert.equal(h.queue.listJobs().length, 0);
    assert.equal(h.fake.submitCount, 0);
  });
});

it("keeps standing key-art constraints and shows a shared full-length prompt once for eight images", async () => {
  const h = await setup(async dir => {
    const path = join(dir, "art-direction/art-direction.json");
    const direction = JSON.parse(await readFile(path, "utf8"));
    direction.failureModes = ["No lens flare on harbour lamps."];
    await writeFile(path, JSON.stringify(direction));
  });
  const prompt = "a".repeat(20_000);
  for (const operation of ["world-image", "master-look"] as const) {
    const action: ModelWorldChatAction = { kind: "image-generation", modelId: MODEL.id, request: { operation, prompt, count: 8 }, checkReceiptIds: [newId("check")] };
    const id = newId("act");
    const body = await h.quotes().prepare(action, id, AT);
    assert.equal(body.quantity, 8);
    assert.equal(body.estimatedMicroUsd, 320_000);
    assert.ok(body.prompt.length < 21_000, "the complete shared prompt is not repeated per result");
    assert.equal(body.prompt.startsWith(prompt), true);
    assert.match(body.prompt, /No lens flare on harbour lamps/);
    if (operation === "world-image") assert.match(body.prompt, /No text, no logos/);
    const quoted = await h.quotes().validate(action, id);
    assert.equal(quoted.inputs.length, 8);
    assert.ok(quoted.inputs.every(input => input.params.prompt === body.prompt));
  }
  assert.equal(h.queue.listJobs().length, 0);
});

it("carries the staged main-photo image with its role, estimate and content pin", async () => {
  const file = "references/maren-kest/head-front.png";
  const h = await setup(async dir => {
    const staged = join(dir, stagedReferenceDir("main-photo--maren-kest"));
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "world.json"), JSON.stringify({ file }));
  });
  h.manifest.models[0]!.pricing = { kind: "perImage", microUsdPerImage: 40_000, microUsdPerReferenceImage: 5_000 };
  const action = mainPhoto();
  const id = newId("act");
  const body = await h.quotes().prepare(action, id, AT);
  assert.equal(body.references.length, 1);
  assert.equal(body.references[0]!.role, "identity");
  assert.equal(body.estimatedMicroUsd, 45_000);
  const { inputs } = await h.quotes().validate(action, id);
  assert.deepEqual(inputs[0]!.params.references, [file]);
  assert.deepEqual(inputs[0]!.params.referenceRoles, [{ file, role: "identity" }]);
  assert.match((inputs[0]!.params.generationQuoteReferences as Array<{ hash: string }>)[0]!.hash, /^[a-f0-9]{64}$/);
  await writeFile(join(h.dir, file), pngBytes());
  await assert.rejects(h.quotes().dispatch(action, id), /changed/);
  assert.equal(h.queue.listJobs().length, 0);
});

for (const operation of ["world-image", "master-look"] as const) {
  it(`serializes competing ${operation} cards and preserves pending paid output`, async () => {
    const h = await setup();
    const action: ModelWorldChatAction = { kind: "image-generation", modelId: MODEL.id,
      request: { operation, prompt: "Salt-lit harbour", count: 1 }, checkReceiptIds: [newId("check")] };
    const ids = [newId("act"), newId("act")];
    await Promise.all(ids.map(id => h.quotes().prepare(action, id, AT)));
    const results = await Promise.allSettled(ids.map(id => h.quotes().dispatch(action, id)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const refused = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    assert.match(String(refused.reason), /already has work or pending candidates/);
    assert.equal(h.queue.listJobs().length, 1);
    await until(() => h.queue.listJobs()[0]?.status === "succeeded", "world image to land", 30_000);
    const file = h.queue.listJobs()[0]!.landedFiles![0]!;
    const original = await readFile(join(h.dir, file));
    await assert.rejects(h.quotes().prepare(action, newId("act"), AT), /pending candidates/);
    await assert.rejects(h.quotes().dispatch(action, ids[results.findIndex(result => result.status === "rejected")]!), /pending candidates/);
    assert.deepEqual(await readFile(join(h.dir, file)), original);
    assert.equal(h.fake.submitCount, 1);
  });
}

for (const format of [{ extension: ".jpg", contentType: "image/jpeg", bytes: jpegBytes() }, { extension: ".webp", contentType: "image/webp", bytes: webpBytes() }]) {
  it(`preserves ${format.extension} prop output through normal queue landing and Take filing`, async () => {
    const h = await setup();
    h.fake.inlineArtifacts = [{ name: `image${format.extension}`, contentType: format.contentType, data: format.bytes }];
    const prop = (await createProp(h.store, "Tide sword"))!;
    const state = (await addPropState(h.store, prop.id, "Broken"))!;
    const action: ModelWorldChatAction = { kind: "image-generation", modelId: MODEL.id,
      request: { operation: "prop-state", propId: prop.id, stateId: state.id, prompt: "Broken at the hilt", count: 1 }, checkReceiptIds: [newId("check")] };
    const id = newId("act");
    await h.quotes().prepare(action, id, AT);
    await h.quotes().dispatch(action, id);
    await until(() => h.queue.listJobs()[0]?.finalization?.status === "complete", "prop format to finalize", 30_000);
    await h.store.reload();
    const take = h.store.getBundle().referenceTakes.find(take => take.jobId === h.queue.listJobs()[0]!.id)!;
    assert.ok(take.media!.endsWith(format.extension));
    assert.ok(h.queue.listJobs()[0]!.landedFiles![0]!.endsWith(format.extension));
    assert.deepEqual(await readFile(join(h.dir, "references", prop.id, "takes", take.id, take.media!)), Buffer.from(format.bytes));
    assert.equal(h.store.getBundle().props.find(one => one.id === prop.id)!.states[0]!.reference, undefined);
    await assert.rejects(readFile(join(h.dir, h.queue.listJobs()[0]!.landedFiles![0]!)), { code: "ENOENT" });
    assert.equal(h.store.getBundle().referenceCandidates[prop.id], undefined, "the staging copy is not exposed as another creative result");
  });
}

it("keeps concurrent establish-look cards in distinct landing files until immutable Take filing", async () => {
  const h = await setup();
  h.fake.onSubmitAccepted = remoteId => {
    const bytes = pngBytes();
    bytes[10] = Number(remoteId.slice(3));
    h.fake.inlineArtifacts = [{ name: "image.png", contentType: "image/png", data: bytes }];
  };
  const action: ModelWorldChatAction = { kind: "reference-generation", modelId: MODEL.id,
    request: { operation: "establish-look", sheetId: "maren-kest", count: 2 }, checkReceiptIds: [newId("check")] };
  const ids = [newId("act"), newId("act")];
  await Promise.all(ids.map(id => h.quotes().prepare(action, id, AT)));
  await Promise.all(ids.map(id => h.quotes().dispatch(action, id)));
  assert.equal(new Set(h.queue.listJobs().map(job => `${job.landing!.dir}/${job.landing!.name}`)).size, 4);
  await until(() => h.queue.listJobs().every(job => job.finalization?.status === "complete"), "distinct establish results to finalize", 30_000);
  await h.store.reload();
  const jobs = h.queue.listJobs();
  const takes = h.store.getBundle().referenceTakes.filter(take => jobs.some(job => job.id === take.jobId));
  assert.equal(takes.length, 4);
  for (const take of takes) {
    const job = jobs.find(job => job.id === take.jobId)!;
    const expected = pngBytes();
    expected[10] = Number(job.providerJobId!.slice(3));
    assert.deepEqual(await readFile(join(h.dir, "references/maren-kest/takes", take.id, take.media!)), Buffer.from(expected));
  }
});

for (const operation of ["world-image", "master-look"] as const) {
  it(`reports an empty ${operation} provider result as failed generation`, async () => {
    const h = await setup();
    h.fake.inlineArtifacts = [];
    const action: ModelWorldChatAction = { kind: "image-generation", modelId: MODEL.id,
      request: { operation, count: 1 }, checkReceiptIds: [newId("check")] };
    const id = newId("act");
    await h.quotes().prepare(action, id, AT);
    await h.quotes().dispatch(action, id);
    await until(() => h.queue.listJobs()[0]?.status === "succeeded", "empty provider result to settle", 30_000);
    const outcome = await h.quotes().reconcile({ actionId: id } as ConversationActionCard);
    assert.equal(outcome!.status, "failed");
    assert.equal(outcome!.receipt!.generation!.completed, 0);
    assert.equal(outcome!.receipt!.generation!.failed, 1);
    assert.match(outcome!.receipt!.generation!.results[0]!.description, /no landed media/);
    assert.equal(outcome!.receipt!.generation!.results[0]!.mediaPath, undefined);
  });
}
