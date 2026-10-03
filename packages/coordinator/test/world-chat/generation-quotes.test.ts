import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { newId, type ConversationActionCard, type LedgerEntry, type ManifestModel, type ModelManifest, type ModelWorldChatAction } from "@arke-studio/contracts";
import { GenerationQuotes } from "../../src/world-chat/generation-quotes.js";
import { imageGenerationSource } from "../../src/world-chat/image-generation.js";
import { WorldStore } from "../../src/world/store.js";
import { JobQueue } from "../../src/queue/dispatcher.js";
import { readContainedImageReferences } from "../../src/world/reference-files.js";
import { recordReferenceTake } from "../../src/references/takes.js";
import { createProp, addPropState } from "../../src/references/props.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempWorld } from "../world/helpers.js";
import { FakeProvider, pngBytes } from "../queue/fake-provider.js";
import { until } from "../wait.js";

const AT = "2026-10-03T12:00:00.000Z";
const MODEL: ManifestModel = { id: "test-image", provider: "fal", capability: "image", displayName: "Test Image",
  accepts: { referenceImages: 4, startFrame: false, endFrame: false }, limits: {}, pricing: { kind: "perImage", microUsdPerImage: 40_000 } };
const mainPhoto = (count = 1): ModelWorldChatAction => ({ kind: "reference-generation", modelId: MODEL.id,
  request: { operation: "main-photo", sheetId: "maren-kest", prompt: "Salt-lit portrait", count, identityReferenceIds: [] }, checkReceiptIds: [newId("check")] });

async function setup() {
  const dir = await makeTempWorld();
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
