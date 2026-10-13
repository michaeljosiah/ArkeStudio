import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, measureAudioSignal, LOCAL_ACTOR_ID, type ConversationActionPrepareIntent, type HarnessAdapter, type AgentMediaInventory, type Take } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { WorldChatStore, conversationDir } from "../../src/world-chat/store.js";
import { WorldChatService } from "../../src/world-chat/service.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { ConversationImages } from "../../src/world-chat/images.js";
import { ConversationMediaInspection } from "../../src/world-chat/media-inspection.js";
import { takeReviewInspectionReason } from "../../src/world-chat/take-review-inspection.js";
import { QueryLeaseRegistry, LeaseDeniedError } from "../../src/world-chat/lease.js";
import { WorldChatRetrieval } from "../../src/world-chat/retrieval.js";
import { WorldChatAttachmentStore } from "../../src/world-chat/attachments.js";
import { WorldQueryServer } from "../../src/harness/world-query.js";
import { BenchStore, sessionDir, sessionMediaDir } from "../../src/bench/store.js";
import { mkdir } from "node:fs/promises";
import { encodePng, solidImage, decodePng } from "../../src/references/png.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const png = encodePng(solidImage(3, 2, [22, 33, 44, 255]));
const inventory: AgentMediaInventory = { durationSec: 10, streams: [
  { index: 0, kind: "video", codec: "fixture", width: 3, height: 2, durationSec: 10, startTimeSec: 0 },
  { index: 1, kind: "audio", codec: "fixture", sampleRate: 4, channels: 2, durationSec: 10, startTimeSec: 0 },
] };
async function harness(options: { local?: boolean; allowed?: boolean; supported?: boolean; inventory?: AgentMediaInventory; missing?: boolean; duringProbe?: () => Promise<void>; duringFrame?: () => Promise<void> } = {}) {
  const dir = await makeTempWorld(), store = await WorldStore.open(dir); closeOnCleanup(() => store.close());
  const cv = newId("cv"), runId = newId("run"), id = newId("ar"), chat = new WorldChatStore(conversationDir(dir, cv));
  await chat.create(cv, "2026-10-13T00:00:00Z"); await chat.append({ type: "conversation.created", title: "Media", entryContext: { kind: "world" } });
  await store.commit({ kind: "media-fixture", source: "test", files: [
    { path: "artifacts/inspect.mp4", action: "create", baseHash: null, encoding: "base64", content: Buffer.from(png).toString("base64") },
    { path: "artifacts/inspect.json", action: "create", baseHash: null, content: JSON.stringify({ id, kind: "video", file: "inspect.mp4", hash: hash(png), links: [], origin: { by: "user" }, created: "2026-10-13T00:00:00Z" }) },
  ] });
  let active: string | null = store.worldId, allowed = options.allowed !== false, frames = 0, snapshots = 0;
  const leases = new QueryLeaseRegistry(() => active), lease = leases.mint({ worldId: store.worldId, conversationId: cv, runId, allowedAttachmentIds: [] });
  const stop = new AbortController();
  const adapter = { imageInput: true, imageInputForSession: () => options.supported !== false, imageDestinationForSession: () => ({ provider: "test-provider", local: options.local === true }) } as unknown as HarnessAdapter;
  const images = new ConversationImages(store, leases, { adapter, allowed: async () => allowed, publish: async () => {} }); images.start(runId, "session", stop.signal);
  const tools = { version: async () => "ffmpeg version fixture", probe: async (path: string) => { snapshots++; assert.deepEqual(await readFile(path), Buffer.from(png)); await options.duringProbe?.(); return options.inventory ?? inventory; },
    frame: async (_path: string, _stream: number, at: number) => { frames++; await options.duringFrame?.(); return { bytes: png, width: 3, height: 2, sourceTimeSec: at }; },
    audio: async (_path: string, stream: AgentMediaInventory["streams"][number], start: number, end: number) => {
      const bytes = Buffer.alloc((end - start) * 4 * 2 * 4); return measureAudioSignal(bytes, 4, 2, stream.index, hash(bytes)); }, };
  const media = new ConversationMediaInspection(store, leases, { images, ...(options.missing ? {} : { tools }) }); media.start(runId, stop.signal);
  const retrieval = new WorldChatRetrieval({ leases, getBundle: () => store.getBundle(), getIndex: () => null, attachments: new WorldChatAttachmentStore(dir), findAttachment: async () => null,
    readImage: (lease, args) => images.read(lease, args), readMedia: (lease, name, args) => media.read(lease, name, args) });
  return { store, leases, lease, cv, images, media, retrieval, source: { kind: "artifact" as const, id }, stop,
    setActive: (id: string | null) => { active = id; }, forbid: () => { allowed = false; }, counts: () => ({ frames, snapshots }),
    loaded: () => new WorldChatService(dir).load(cv) };
}
test("metadata receipts replay and raise the reader boundary without claiming pixels or listening", async () => {
  const h = await harness(), outcome = await h.retrieval.call(h.lease.token, "inspect_media", { source: h.source });
  assert.equal(outcome.receipt.media!.coverage, "metadata-only"); assert.equal(outcome.imageContent, undefined);
  assert.equal((await h.loaded())!.mediaReceipts!.length, 1); assert.equal(h.store.getBundle().meta.schemaVersion, 78);
  await assert.rejects(readWorldMeta(h.store.dir, { supports: 77 }), /newer|version|schema/i);
});
test("sampled frames deliver actual pixels, source times, source/rendition hashes and cloud disclosures", async () => {
  const h = await harness(), outcome = await h.retrieval.call(h.lease.token, "sample_video", { source: h.source, range: { startSec: 1, endSec: 3 }, count: 2 });
  assert.equal(outcome.receipt.media!.coverage, "sampled-frames-only"); assert.deepEqual(outcome.receipt.media!.frames!.map(frame => frame.sourceTimeSec), [1, 2]);
  const bytes = Buffer.from(outcome.imageContent![0]!.data, "base64"); assert.equal(hash(bytes), outcome.receipt.media!.frames![0]!.image.renditionHash);
  assert.deepEqual(Array.from(decodePng(bytes).pixels.slice(0, 4)), [22, 33, 44, 255]);
  const loaded = await h.loaded(); assert.equal(loaded!.imageDisclosures![0]!.images.length, 2); assert.equal(loaded!.mediaReceipts!.length, 1);
  assert.match(outcome.receipt.media!.limitations.join(" "), /remain unreviewed/);
});
test("audio sample evidence retains rate and separate channels and never discloses raw audio", async () => {
  const h = await harness(), outcome = await h.retrieval.call(h.lease.token, "analyze_audio_signal", { source: h.source, range: { startSec: 0, endSec: 1 } });
  assert.equal(outcome.receipt.media!.audio!.channels.length, 2); assert.equal(outcome.receipt.media!.audio!.sampleRate, 4);
  assert.equal(outcome.imageContent, undefined); assert.equal((await h.loaded())!.imageDisclosures, undefined);
});
test("the shared leased MCP catalog serves frame images as image blocks and records the matching receipt", async () => {
  const h = await harness(), server = new WorldQueryServer(() => h.store); await server.start(); closeOnCleanup(() => server.stop());
  let served = ""; server.attachLease(h.lease.token, { retrieval: h.retrieval, onReceipt: receipt => { served = receipt.tool; } });
  const rpc = async (method: string, params?: unknown) => (await fetch(server.leasedUrl(h.lease.token)!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  const listed = await rpc("tools/list") as { result: { tools: Array<{ name: string }> } };
  for (const name of ["inspect_media", "sample_video", "analyze_audio_signal"]) assert.ok(listed.result.tools.some((tool: { name: string }) => tool.name === name));
  const reply = await rpc("tools/call", { name: "sample_video", arguments: { source: h.source, range: { startSec: 0, endSec: 1 }, count: 2 } }) as { result: { content: Array<{ type: string }> } };
  assert.equal(reply.result.content.filter((block: { type: string }) => block.type === "image").length, 2); assert.equal(served, "sample-video");
  assert.equal((await h.loaded())!.mediaReceipts!.length, 1);
});
for (const option of [{ supported: false }, { allowed: false }, { missing: true }]) test(`video refusal before decoding: ${JSON.stringify(option)}`, async () => {
  const h = await harness(option), result = await h.retrieval.call(h.lease.token, "sample_video", { source: h.source, range: { startSec: 0, endSec: 1 } });
  assert.equal(result.receipt.status, "unavailable"); assert.equal(h.counts().frames, 0); assert.equal((await h.loaded())!.mediaReceipts, undefined);
});
test("local image inspection needs no cloud permission or disclosure; the shared image budget still applies", async () => {
  const h = await harness({ local: true, allowed: false });
  for (let i = 0; i < 3; i++) assert.equal((await h.retrieval.call(h.lease.token, "sample_video", { source: h.source, range: { startSec: 0, endSec: 1 }, count: 8 })).receipt.status, "complete");
  const refused = await h.retrieval.call(h.lease.token, "sample_video", { source: h.source, range: { startSec: 0, endSec: 1 } }); assert.equal(refused.receipt.status, "unavailable");
  assert.equal((await h.loaded())!.imageDisclosures, undefined); assert.equal((await h.loaded())!.mediaReceipts!.length, 3);
});
test("ambiguous audio tracks require explicit stream selection", async () => {
  const h = await harness({ inventory: { ...inventory, streams: [...inventory.streams, { ...inventory.streams[1]!, index: 2 }] } });
  await assert.rejects(h.retrieval.call(h.lease.token, "analyze_audio_signal", { source: h.source, range: { startSec: 0, endSec: 1 } }), /explicit audio stream/);
  const selected = await h.retrieval.call(h.lease.token, "analyze_audio_signal", { source: h.source, range: { startSec: 0, endSec: 1 }, streamIndex: 2 });
  assert.equal(selected.receipt.media!.audio!.streamIndex, 2);
});
test("changed source bytes cannot produce a receipt from a previously verified snapshot", async () => {
  let path = ""; const h = await harness({ duringProbe: async () => { await writeFile(path, "changed"); } }); path = join(h.store.dir, "artifacts", "inspect.mp4");
  const outcome = await h.retrieval.call(h.lease.token, "inspect_media", { source: h.source });
  assert.equal(outcome.receipt.status, "unavailable"); assert.equal((await h.loaded())!.mediaReceipts, undefined);
});
for (const revoke of ["abort", "world", "lease", "privacy", "close"] as const) test(`inspection cannot finish after ${revoke} changes`, async () => {
  let h: Awaited<ReturnType<typeof harness>>; h = await harness({ duringFrame: async () => { if (revoke === "abort") h.stop.abort(); else if (revoke === "world") h.setActive(null); else if (revoke === "lease") h.leases.revokeRun(h.lease.runId); else if (revoke === "close") await h.store.close(); else h.forbid(); } });
  try { const value = await h.retrieval.call(h.lease.token, "sample_video", { source: h.source, range: { startSec: 0, endSec: 1 } }); assert.equal(value.receipt.status, "unavailable"); }
  catch (error) { assert.ok(error instanceof LeaseDeniedError); }
  assert.equal((await h.loaded())!.mediaReceipts, undefined); assert.equal((await h.loaded())!.imageDisclosures, undefined);
});
test("an artifact filename cannot escape its authority folder and hashless legacy takes stay unreadable", async () => {
  const h = await harness(), path = "artifacts/inspect.json", before = await readFile(join(h.store.dir, path));
  const artifact = JSON.parse(before.toString("utf8")); artifact.file = "../world-art.png";
  await h.store.commit({ kind: "escape-fixture", source: "test", files: [{ path, action: "replace", baseHash: hash(before), content: JSON.stringify(artifact) }] });
  assert.equal((await h.retrieval.call(h.lease.token, "inspect_media", { source: h.source })).receipt.status, "unavailable");
  const production = h.store.getBundle().productions.find(value => value.meta.id === "saltlight")!, base = production.takes.find(take => take.kind === "clip")!;
  const take: Take = { ...base, id: newId("tk"), media: "legacy.mp4" }; delete take.mediaHash;
  await h.store.commit({ kind: "legacy-fixture", source: "test", files: [{ path: `productions/saltlight/takes/${take.id}/take.json`, action: "create", baseHash: null, content: JSON.stringify(take) }] });
  assert.equal((await h.retrieval.call(h.lease.token, "inspect_media", { source: { kind: "production-take", productionId: "saltlight", takeId: take.id } })).receipt.status, "unavailable");
  assert.equal(h.counts().snapshots, 0);
});
test("Bench inspection resolves a named immutable take, independently of mutable selections", async () => {
  const h = await harness(), sessionId = newId("sess"), takeId = newId("tk"), bench = new BenchStore(sessionDir(h.store.dir, sessionId));
  await bench.create(sessionId, "2026-10-13T00:00:00Z");
  await bench.append({ type: "takes-reserved", takes: [{ id: takeId, n: 1, requestId: "media-test", request: { mode: "image", brief: "Look", references: [], keyframes: [], provider: "fal", model: "fixture", params: { kind: "image", count: 1 } }, createdAt: "2026-10-13T00:00:00Z" }] });
  const media = join(h.store.dir, sessionMediaDir(sessionId, takeId)); await mkdir(media, { recursive: true }); await writeFile(join(media, "look.png"), png);
  await bench.append({ type: "take-completed", takeId, media: { file: "look.png", hash: hash(png) }, completedAt: "2026-10-13T00:00:00Z" });
  const outcome = await h.retrieval.call(h.lease.token, "inspect_media", { source: { kind: "bench-take", sessionId, takeId } });
  assert.equal(outcome.receipt.media!.sourceHash, hash(png)); assert.equal(outcome.receipt.media!.source.kind, "bench-take");
});
test("inspection range, immutable identity and host call budgets are enforced", async () => {
  const h = await harness();
  for (const args of [{ source: { path: "/private" } }, { source: h.source, range: { startSec: 0, endSec: 11 } }]) await assert.rejects(h.retrieval.call(h.lease.token, "sample_video", args));
  for (let i = 0; i < 15; i++) await h.retrieval.call(h.lease.token, "inspect_media", { source: h.source });
  await assert.rejects(h.retrieval.call(h.lease.token, "inspect_media", { source: h.source }), /call budget/);
});
test("a trimmed segment reports both take-relative and actual source times", async () => {
  const h = await harness(), production = h.store.getBundle().productions.find(value => value.meta.id === "saltlight")!, base = production.takes.find(take => take.kind === "clip")!;
  const parentId = newId("tk"), segmentId = newId("tk"), parent: Take = { ...base, id: parentId, media: "source.mp4", mediaHash: hash(png) };
  const segment: Take = { ...base, id: segmentId, segment: { passTakeId: parentId, inSec: 2, outSec: 5 } }; delete segment.media; delete segment.mediaHash;
  await h.store.commit({ kind: "segment-fixture", source: "test", files: [
    { path: `productions/saltlight/takes/${parentId}/source.mp4`, action: "create", baseHash: null, encoding: "base64", content: Buffer.from(png).toString("base64") },
    ...[parent, segment].map(take => ({ path: `productions/saltlight/takes/${take.id}/take.json`, action: "create" as const, baseHash: null, content: JSON.stringify(take) })),
  ] });
  const outcome = await h.retrieval.call(h.lease.token, "sample_video", { source: { kind: "production-take", productionId: "saltlight", takeId: segmentId }, range: { startSec: .5, endSec: 1.5 }, count: 1 });
  assert.equal(outcome.receipt.media!.frames![0]!.sourceTimeSec, 2.5); assert.equal(outcome.receipt.media!.frames![0]!.viewTimeSec, .5);
});
test("take-review coverage requires served evidence in its completed run and still-current source bytes", async () => {
  const h = await harness(), production = h.store.getBundle().productions.find(value => value.meta.id === "saltlight")!, base = production.takes.find(take => take.kind === "clip")!;
  const take: Take = { ...base, id: newId("tk"), media: "review.mp4", mediaHash: hash(png) }, path = `productions/saltlight/takes/${take.id}/review.mp4`;
  await h.store.commit({ kind: "review-media-fixture", source: "test", files: [
    { path, action: "create", baseHash: null, encoding: "base64", content: Buffer.from(png).toString("base64") },
    { path: `productions/saltlight/takes/${take.id}/take.json`, action: "create", baseHash: null, content: JSON.stringify(take) },
  ] });
  const source = { kind: "production-take", productionId: "saltlight", takeId: take.id }, range = { startSec: 0, endSec: 1 };
  const frames = await h.retrieval.call(h.lease.token, "sample_video", { source, range, count: 1 }), audio = await h.retrieval.call(h.lease.token, "analyze_audio_signal", { source, range });
  const at = "2026-10-13T00:00:00Z", turnId = newId("turn"), intent: ConversationActionPrepareIntent = {
    actionId: newId("act"), conversationId: h.cv, turnId, worldId: h.store.worldId, productionId: "saltlight", actorId: LOCAL_ACTOR_ID,
    scope: "production", actionKind: "production-take-review", authorityKind: "take-review", cardFamily: "take-review", targets: [{ kind: "take", id: take.id }],
    payloadDigest: hash(png), baseObservations: [], dependencies: [], createdAt: at,
  };
  assert.match(await takeReviewInspectionReason(h.store, intent, production, take), /Metadata-only/);
  const chat = new WorldChatStore(conversationDir(h.store.dir, h.cv));
  await chat.append({ type: "turn.completed", message: { id: newId("msg"), turnId, role: "studio", text: "Review", attachmentIds: [], createdAt: at },
    run: { id: h.lease.runId, turnId, basedOnConversationSeq: 1, status: "completed", adapter: "fixture", harnessCleanup: "not-required", contextDigest: hash(png), startedAt: at, endedAt: at },
    receipts: [frames.receipt, audio.receipt], candidates: [], groups: [], tombstones: [], actionPrepareIntents: [intent] });
  const reason = await takeReviewInspectionReason(h.store, intent, production, take);
  assert.match(reason, /1 timestamped still frames/); assert.match(reason, /Original-channel audio sample measurements/); assert.match(reason, /no listening or performance judgment/);
  await writeFile(join(h.store.dir, path), "changed");
  assert.match(await takeReviewInspectionReason(h.store, intent, production, take), /Metadata-only/);
});
