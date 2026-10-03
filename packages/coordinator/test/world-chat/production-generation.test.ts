import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { newId, type ManifestModel, type ModelManifest, type ModelWorldChatAction, type ConversationActionCard, type LedgerEntry } from "@arke-studio/contracts";
import { productionGenerationSource } from "../../src/world-chat/production-generation.js";
import { GenerationQuotes } from "../../src/world-chat/generation-quotes.js";
import { WorldStore } from "../../src/world/store.js";
import { JobQueue } from "../../src/queue/dispatcher.js";
import { recordTakesFromJob } from "../../src/takes/arrival.js";
import { readContainedImageReferences, readContainedVideoReferences } from "../../src/world/reference-files.js";
import { recordUploadedShotFrameTake, acceptStill } from "../../src/takes/drawn-frame.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import { FakeProvider, pngBytes } from "../queue/fake-provider.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { until } from "../wait.js";

const AT = "2026-10-03T12:00:00.000Z";
const IMAGE: ManifestModel = { id: "test-image", provider: "fal", capability: "image", displayName: "Test Image",
  accepts: { referenceImages: 16, startFrame: false, endFrame: false }, limits: { aspects: ["16:9"] }, pricing: { kind: "perImage", microUsdPerImage: 40_000 } };
const VIDEO: ManifestModel = { id: "test-video", provider: "fal", capability: "video", displayName: "Test Video",
  accepts: { referenceImages: 16, startFrame: true, endFrame: false },
  modes: { generate: { locked: [] }, "first-frame": { locked: [], route: "first-frame-route" } },
  limits: { maxDurationSec: 30, aspects: ["16:9"], soundChoice: true, durations: { "4": "4", "6": "6", "8": "8", "10": "10", "15": "15", "20": "20", "30": "30" } },
  pricing: { kind: "perSecond", microUsdPerSecond: 100_000 } };
const videoAction = (): Extract<ModelWorldChatAction, { kind: "production-take-generation" }> => ({ kind: "production-take-generation",
  productionId: "saltlight", sceneId: "sc_04", target: { kind: "shot", shotId: "sh_12" }, mode: "video", modelId: VIDEO.id,
  instruction: "Keep the camera steady.", checkReceiptIds: [newId("check")] });
function mp4() { const box = (name: string) => [0, 0, 0, 8, ...new TextEncoder().encode(name)]; return Uint8Array.from([...box("ftyp"), ...box("moov"), ...box("mdat")]); }

async function setup(beforeOpen?: (dir: string) => Promise<void>) {
  const dir = await makeTempWorld();
  await beforeOpen?.(dir);
  const store = await WorldStore.open(dir, { clock: () => AT });
  closeOnCleanup(() => store.close());
  const manifest: ModelManifest = { manifestVersion: 1, generated: "2026-10-03", models: [structuredClone(IMAGE), structuredClone(VIDEO)] };
  const source = productionGenerationSource(store, { manifest, settings: async () => null, freeze: input => input,
    sources: { read: async path => ({ hash: `sha256:${createHash("sha256").update(await readFile(join(dir, path))).digest("hex").slice(0, 16)}` }), durationSec: async () => 4 } });
  const fake = new FakeProvider({ supportsIdempotencyKey: true, supportsLookupByKey: true });
  fake.inlineArtifacts = [{ name: "clip.mp4", contentType: "video/mp4", data: mp4() }];
  const ledger: LedgerEntry[] = [];
  const queue = new JobQueue({ journalPath: join(dir, "test-jobs.jsonl"), clients: { fal: fake }, getKey: async () => "test", emit: () => {},
    ledger: { readJobIds: async () => new Set(ledger.map(entry => entry.jobId)), has: async id => ledger.some(entry => entry.jobId === id), append: async entry => { ledger.push(entry); } },
    onProviderFault: () => {}, readImageReferences: (_id, paths) => readContainedImageReferences(dir, paths),
    readVideoReferences: (_id, paths) => readContainedVideoReferences(dir, paths),
    landInWorld: async (_id, land) => { await store.ownedWrite(() => land(dir)); return true; },
    onTerminal: async job => { if (job.status === "succeeded") await recordTakesFromJob(store, job, null); }, baseIntervalMs: 1, pollIntervalMs: 5 });
  closeOnCleanup(() => queue.dispose());
  await queue.start();
  const quotes = () => new GenerationQuotes(store, source, { enqueue: input => queue.enqueue(input), jobs: () => queue.listJobs() });
  return { dir, store, source, manifest, fake, queue, quotes };
}

describe("quoted production take generation (SPEC-051 R-4..7, R-11..12)", () => {
  for (const mode of ["image", "video"] as const) it(`files a board's ${mode} results as candidates on all of its members`, async () => {
    const h = await setup();
    const memberShotIds = ["sh_12", "sh_13", "sh_14", "sh_15"];
    const action = { ...videoAction(), mode, modelId: mode === "image" ? IMAGE.id : VIDEO.id, target: { kind: "board" as const, memberShotIds } };
    if (mode === "image") h.fake.inlineArtifacts = [{ name: "frame.png", contentType: "image/png", data: pngBytes() }];
    const before = structuredClone(h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!.selections);
    const id = newId("act");
    const body = await h.quotes().prepare(action, id, AT);
    assert.equal(body.quantity, mode === "image" ? 4 : 1);
    await h.quotes().dispatch(action, id);
    await until(() => h.queue.listJobs().length === body.quantity && h.queue.listJobs().every(job => job.finalization?.status === "complete"), "board candidate filing", 30_000);
    await h.store.reload();
    const production = h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!;
    const takes = production.takes.filter(t => h.queue.listJobs().some(job => job.id === t.jobId));
    assert.ok(memberShotIds.every(id => takes.some(t => t.coversShots.length === 1 && t.coversShots[0] === id)));
    assert.deepEqual(production.selections, before);
    assert.ok(takes.every(t => !production.reviews.some(r => r.takeId === t.id)));
    if (mode === "video") {
      const parent = takes.find(t => t.media)!;
      assert.equal(takes.filter(t => t.segment?.passTakeId === parent.id).length, 4);
      assert.equal(takes.filter(t => t.media).length, 1, "a board owns one video with planned segment ranges");
      const children = takes.filter(t => t.segment).sort((a, b) => a.segment!.inSec - b.segment!.inSec);
      const metadata = await Promise.all([parent, ...children].map(t => readFile(join(h.dir, "productions/saltlight/takes", t.id, "take.json"), "utf8")));
      await h.store.ownedWrite(() => rm(join(h.dir, "productions/saltlight/takes", children[1]!.id, "take.json")));
      const replayed = await recordTakesFromJob(h.store, h.queue.listJobs()[0]!, null);
      assert.deepEqual(replayed.map(t => t.id), [parent.id, ...children.map(t => t.id)]);
      assert.deepEqual(await Promise.all(replayed.map(t => readFile(join(h.dir, "productions/saltlight/takes", t.id, "take.json"), "utf8"))), metadata);
      assert.equal(h.fake.submitCount, 1, "recovery repairs missing segments without another provider call");
    }
  });
  it("approves one video job exactly once, files its take on the shot, and leaves selections unchanged", async () => {
    const h = await setup();
    const action = videoAction();
    const id = newId("act");
    const before = structuredClone(h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!.selections);
    const body = await h.quotes().prepare(action, id, AT);
    assert.equal(body.model, VIDEO.id);
    assert.equal(body.quantity, 1);
    assert.ok(body.estimatedMicroUsd! > 0);
    assert.match(body.prompt, /Keep the camera steady/);
    assert.equal(h.fake.submitCount, 0);
    assert.equal(h.queue.listJobs().length, 0);
    assert.deepEqual(await h.quotes().prepare(action, id, AT), body);
    assert.equal((await h.quotes().dispatch(action, id)).status, "queued");
    await h.quotes().dispatch(action, id);
    await until(() => h.queue.listJobs()[0]?.finalization?.status === "complete", "production take finalization", 30_000);
    await h.store.reload();
    const production = h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!;
    const take = production.takes.find(t => t.jobId === h.queue.listJobs()[0]!.id)!;
    assert.equal(h.fake.submitCount, 1);
    assert.equal(h.queue.listJobs().length, 1);
    assert.deepEqual(take.coversShots, ["sh_12"]);
    assert.equal(take.kind, "clip");
    assert.deepEqual(production.selections, before);
    assert.equal(production.reviews.some(r => r.takeId === take.id), false);
    const metadataPath = join(h.dir, "productions/saltlight/takes", take.id, "take.json");
    const metadata = await readFile(metadataPath, "utf8");
    assert.deepEqual((await recordTakesFromJob(h.store, h.queue.listJobs()[0]!, null)).map(t => t.id), [take.id]);
    assert.equal(await readFile(metadataPath, "utf8"), metadata);
    await h.store.ownedWrite(() => rm(metadataPath));
    assert.deepEqual((await recordTakesFromJob(h.store, h.queue.listJobs()[0]!, null)).map(t => t.id), [take.id], "recovers after media moved but before metadata was durable");
    assert.equal(h.fake.submitCount, 1);
    const receipt = await h.quotes().reconcile({ actionId: id } as ConversationActionCard);
    assert.equal(receipt?.status, "completed");
    assert.equal(receipt?.receipt?.generation?.results[0]?.medium, "video");
    assert.match(receipt?.receipt?.generation?.results[0]?.mediaPath ?? "", new RegExp(`takes/${take.id}/clip.mp4$`));
  });
  it("denies without jobs and refuses changed price, target context or selected-frame bytes", async () => {
    const h = await setup();
    const action = videoAction();
    const denied = newId("act");
    await h.quotes().prepare(action, denied, AT);
    await h.quotes().abandon(denied);
    await assert.rejects(h.quotes().dispatch(action, denied), /unavailable/);
    const id = newId("act");
    await h.quotes().prepare(action, id, AT);
    h.manifest.models[1]!.pricing = { kind: "perSecond", microUsdPerSecond: 200_000 };
    await assert.rejects(h.quotes().dispatch(action, id), /changed/);
    h.manifest.models[1]!.pricing = VIDEO.pricing;
    const frame = await recordUploadedShotFrameTake(h.store, "saltlight", "sh_12", "frame.png", encodePng(solidImage(4, 4, [20, 40, 60, 255])));
    await acceptStill(h.store, h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!, { takeId: frame.id, shotId: "sh_12", by: "test" });
    await assert.rejects(h.quotes().dispatch(action, id), /changed/);
    const fresh = newId("act");
    const body = await h.quotes().prepare(action, fresh, AT);
    assert.ok(body.references.some(ref => /frame/i.test(ref.role)));
    const input = (await h.quotes().validate(action, fresh)).inputs[0]!;
    assert.equal(input.params.taskMode, "first-frame");
    assert.equal(input.params.route, "first-frame-route");
    const path = (input.params.references as string[])[0]!;
    const changed = pngBytes(); changed[10] = 9;
    await writeFile(join(h.dir, path), changed);
    await assert.rejects(h.quotes().dispatch(action, fresh), /changed/);
    assert.equal(h.fake.submitCount, 0);
  });
  it("discloses missing kits and makes retake image candidates without accepting them", async () => {
    const h = await setup(dir => rm(join(dir, "references/maren-kest/kit.json")));
    h.fake.inlineArtifacts = [{ name: "frame.png", contentType: "image/png", data: pngBytes() }];
    const prior = h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!.takes.find(t => t.coversShots.includes("sh_12"))!;
    const action = { ...videoAction(), mode: "image" as const, modelId: IMAGE.id, count: 2, retakeOf: prior.id };
    const id = newId("act");
    const body = await h.quotes().prepare(action, id, AT);
    assert.equal(body.quantity, 2);
    assert.match(body.purpose, new RegExp(prior.id));
    assert.ok(body.exclusions?.some(line => /no reference kit.*generation card/i.test(line)));
    await h.quotes().dispatch(action, id);
    await until(() => h.queue.listJobs().length === 2 && h.queue.listJobs().every(job => job.finalization?.status === "complete"), "two frame candidates", 30_000);
    await h.store.reload();
    const production = h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!;
    const takes = production.takes.filter(t => h.queue.listJobs().some(job => job.id === t.jobId));
    assert.equal(takes.length, 2);
    assert.ok(takes.every(t => t.kind === "frame" && t.coversShots.includes("sh_12")));
    assert.ok(takes.every(t => !production.reviews.some(r => r.takeId === t.id)));
  });
  it("checks Stage clip bytes again before provider submission", async () => {
    const h = await setup();
    await mkdir(join(h.dir, "test-media"), { recursive: true });
    await writeFile(join(h.dir, "test-media/stage.mp4"), mp4());
    const action = videoAction();
    const id = newId("act");
    const source = { compile: async () => { const prepared = await h.source.compile(action, id, AT); return { ...prepared,
      inputs: prepared.inputs.map(input => ({ ...input, params: { ...input.params, videoReferences: ["test-media/stage.mp4"] } })) }; } };
    const quotes = new GenerationQuotes(h.store, source, { enqueue: input => h.queue.enqueue(input), jobs: () => h.queue.listJobs() });
    await quotes.prepare(action, id, AT);
    const input = (await quotes.validate(action, id)).inputs[0]!;
    await writeFile(join(h.dir, "test-media/stage.mp4"), Uint8Array.from([...mp4(), 0, 0, 0, 8, ...new TextEncoder().encode("free")]));
    const job = await h.queue.enqueue(input);
    await until(() => h.queue.listJobs().find(j => j.id === job.id)?.status === "failed", "changed video reference refusal", 30_000);
    assert.equal(h.fake.submitCount, 0);
    assert.match(h.queue.listJobs().find(j => j.id === job.id)!.error!, /Video references changed after generation approval/);
  });
  it("omits cast audio clearance and acknowledgement on a first-frame route", async () => {
    const h = await setup();
    h.manifest.models[1]!.id = "seedance-2.0";
    const frame = await recordUploadedShotFrameTake(h.store, "saltlight", "sh_12", "frame.png", encodePng(solidImage(4, 4, [20, 40, 60, 255])));
    await acceptStill(h.store, h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!, { takeId: frame.id, shotId: "sh_12", by: "test" });
    const action = { ...videoAction(), modelId: "seedance-2.0" };
    const id = newId("act");
    const body = await h.quotes().prepare(action, id, AT);
    const quote = await h.quotes().validate(action, id);
    assert.equal(quote.inputs[0]!.params.taskMode, "first-frame");
    assert.equal(quote.inputs[0]!.params.audioReferences, undefined);
    assert.deepEqual(quote.materialization, [], "no unsupported cast clearance is acknowledged on approval");
    assert.ok(body.exclusions?.some(line => /Cast audio not sent.*first-frame/.test(line)));
    assert.equal(body.references.some(ref => ref.role.startsWith("Cast voice:")), false);
  });
});
