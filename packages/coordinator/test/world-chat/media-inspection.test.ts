import assert from "node:assert/strict";
import { test } from "node:test";
import { VoxaClient, VoxaCancelledError, VoxaTimeoutError } from "@arke-studio/voice";
import { createHash } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { newId, measureAudioSignal, LOCAL_ACTOR_ID, type ConversationActionPrepareIntent, type HarnessAdapter, type AgentMediaInventory, type Take, orderedShots, resolvePerformanceLine, ScratchPerformanceSchema } from "@arke-studio/contracts";
import { wav } from "../audio/helpers.js";
import { analyzePcmWav } from "../../src/audio/qc.js";
import { writeSpeechWav } from "../../src/audio/speech-wav.js";
import type { AgentSpeechReader, AgentSpeechTextReader } from "../../src/media/agent-speech.js";
import type { AgentAudioListener } from "../../src/media/agent-listening.js";
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
import { recordCompletedExport } from "../../src/productions/export-receipts.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const png = encodePng(solidImage(3, 2, [22, 33, 44, 255]));
const inventory: AgentMediaInventory = { durationSec: 10, streams: [
  { index: 0, kind: "video", codec: "fixture", width: 3, height: 2, durationSec: 10, startTimeSec: 0 },
  { index: 1, kind: "audio", codec: "fixture", sampleRate: 4, channels: 2, durationSec: 10, startTimeSec: 0 },
] };
/** Sound with nothing standing over its own level: a read of it is one reader call on the whole interval, as every read once was. */
const tone = (start: number, end: number) => Float32Array.from({ length: Math.round((end - start) * 16000) }, (_, i) => .1 * Math.sin(2 * Math.PI * 220 * i / 16000));
/** Film sound: a room that is never silent, and a line wherever `lines` says, in seconds from the interval's start. */
const filmSound = (lines: Array<[number, number]>) => (start: number, end: number) => {
  let state = 7;
  const noise = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2147483648 - 1; };
  const samples = new Float32Array(Math.round((end - start) * 16000)).map(() => .008 * noise());
  for (const [from, to] of lines) for (let i = from * 16000; i < to * 16000; i++) samples[i]! += .15 * Math.sin(2 * Math.PI * 220 * i / 16000);
  return samples;
};
const unplaced = () => new Error("a word has no usable timing or an unresolved pause");
/** What a refusal says is left of the run's budgets. */
const left = (speech: number, media: number, listening = 2, images = 24) => ` Left in this run: ${speech} speech, ${media} media and ${listening} listening calls, ${images} images.`;
async function harness(options: { sourceBytes?: Uint8Array; listener?: AgentAudioListener; speech?: AgentSpeechReader; speechText?: AgentSpeechTextReader; sound?: (start: number, end: number) => Float32Array; speechReady?: (signal: AbortSignal) => Promise<boolean>; local?: boolean; allowed?: boolean; supported?: boolean; inventory?: AgentMediaInventory; missing?: boolean; duringProbe?: () => Promise<void>; duringFrame?: () => Promise<void>; duringPublish?: () => Promise<void> } = {}) {
  const bytes = options.sourceBytes ?? png;
  const dir = await makeTempWorld(), store = await WorldStore.open(dir); closeOnCleanup(() => store.close());
  const cv = newId("cv"), runId = newId("run"), id = newId("ar"), chat = new WorldChatStore(conversationDir(dir, cv));
  await chat.create(cv, "2026-10-13T00:00:00Z"); await chat.append({ type: "conversation.created", title: "Media", entryContext: { kind: "world" } });
  await store.commit({ kind: "media-fixture", source: "test", files: [
    { path: "artifacts/inspect.mp4", action: "create", baseHash: null, encoding: "base64", content: Buffer.from(bytes).toString("base64") },
    { path: "artifacts/inspect.json", action: "create", baseHash: null, content: JSON.stringify({ id, kind: "video", file: "inspect.mp4", hash: hash(bytes), links: [], origin: { by: "user" }, created: "2026-10-13T00:00:00Z" }) },
  ] });
  let active: string | null = store.worldId, allowed = options.allowed !== false, frames = 0, snapshots = 0;
  const leases = new QueryLeaseRegistry(() => active), lease = leases.mint({ worldId: store.worldId, conversationId: cv, runId, allowedAttachmentIds: [] });
  const stop = new AbortController();
  const adapter = { imageInput: true, imageInputForSession: () => options.supported !== false, imageDestinationForSession: () => ({ provider: "test-provider", local: options.local === true }) } as unknown as HarnessAdapter;
  const images = new ConversationImages(store, leases, { adapter, allowed: async () => allowed, publish: async () => {} }); images.start(runId, "session", stop.signal);
  const tools = { version: async () => "ffmpeg version fixture", probeVersion: async () => "ffprobe version fixture", probe: async (path: string) => { snapshots++; assert.deepEqual(await readFile(path), Buffer.from(bytes)); await options.duringProbe?.(); return options.inventory ?? inventory; },
    frame: async (_path: string, _stream: number, at: number) => { frames++; await options.duringFrame?.(); return { bytes: png, width: 3, height: 2, sourceTimeSec: at }; },
    audio: async (_path: string, stream: AgentMediaInventory["streams"][number], start: number, end: number) => {
      const bytes = Buffer.alloc((end - start) * 4 * 2 * 4); return measureAudioSignal(bytes, 4, 2, stream.index, hash(bytes)); },
    speechAudio: async (_path: string, _stream: unknown, start: number, end: number) => ({ bytes: writeSpeechWav({ rate: 16000, samples: (options.sound ?? tone)(start, end) }), durationSec: end - start }), };
  const media = new ConversationMediaInspection(store, leases, { images, listener: options.listener, speech: options.speech, speechText: options.speechText, speechReady: options.speechReady, publish: options.duringPublish, ...(options.missing ? {} : { tools }) }); media.start(runId, stop.signal);
  const retrieval = new WorldChatRetrieval({ leases, getBundle: () => store.getBundle(), getIndex: () => null, attachments: new WorldChatAttachmentStore(dir), findAttachment: async () => null,
    readImage: (lease, args) => images.read(lease, args), readMedia: (lease, name, args) => media.read(lease, name, args) });
  return { store, leases, lease, cv, images, media, retrieval, source: { kind: "artifact" as const, id }, stop,
    setActive: (id: string | null) => { active = id; }, forbid: () => { allowed = false; }, counts: () => ({ frames, snapshots }),
    loaded: () => new WorldChatService(dir).load(cv) };
}
test("metadata receipts replay and raise the reader boundary without claiming pixels or listening", async () => {
  const h = await harness(), outcome = await h.retrieval.call(h.lease.token, "inspect_media", { source: h.source });
  assert.equal(outcome.receipt.media!.coverage, "metadata-only"); assert.equal(outcome.imageContent, undefined);
  assert.equal((await h.loaded())!.mediaReceipts!.length, 1); assert.equal(h.store.getBundle().meta.schemaVersion, 79);
  await assert.rejects(readWorldMeta(h.store.dir, { supports: 78 }), /newer|version|schema/i);
});

const speechAnswer = { text: "Stay here", seconds: 1, engine: { id: "whisper.cpp/dtw-word-boundaries-v1", version: "fixture-1", model: "fixture" },
  words: [{ text: "Stay", startSec: .1, endSec: .3, probability: .9 }, { text: "here", startSec: .4, endSec: .8, probability: .2 }] };

const listeningAnswer = { engine: { id: "local-qwen2-audio-v1" as const, model: "Qwen2-Audio-7B-Instruct" as const,
  modelHash: hash(Buffer.from("model fixture")), runtime: "fixture-1" }, review: "The voice sounds restrained; soft strings support the slow pulse." };
const listener: AgentAudioListener = { ready: async () => true, listen: async () => listeningAnswer };

test("a safe Voxa refusal after successful decode stays a speech refusal and spends no speech call; the media call budget is what ends a run of them", async () => {
  const client = new VoxaClient(async () => new Response(JSON.stringify({ detail: "The recognizer returned multiple words under one timestamp." }),
    { status: 422, headers: { "content-type": "application/problem+json" } }), "http://127.0.0.1:9");
  let recognized = 0;
  const h = await harness({ speech: async (bytes, signal) => { recognized++; assert.ok(bytes.length > 32000); return client.transcribeWords(bytes, { signal }); } });
  const before = h.store.getBundle().meta.schemaVersion, args = { source: h.source, range: { startSec: 0, endSec: 1 } };
  try {
    for (let i = 0; i < 16; i++) {
      const outcome = await h.retrieval.call(h.lease.token, "transcribe_audio", args);
      assert.equal(outcome.receipt.status, "unavailable");
      assert.deepEqual(outcome.result, { unavailable: true, reason: "Local speech recognition unavailable: the recognizer grouped multiple words under one timestamp." + left(4, 15 - i) });
    }
    assert.equal(recognized, 16); assert.equal(h.counts().snapshots, 16);
    await assert.rejects(h.retrieval.call(h.lease.token, "transcribe_audio", args), /media inspection call budget\. Left in this run: 4 speech, 0 media/);
    assert.equal(h.store.getBundle().meta.schemaVersion, before); assert.equal((await h.loaded())!.mediaReceipts, undefined);
  } finally { client.dispose(); }
});

test("four answered speech reads are the budget, and the refusals between them take none of it", async () => {
  let reads = 0;
  const h = await harness({ speech: async () => { if (++reads % 2) throw unplaced(); return speechAnswer; } });
  const args = { source: h.source, range: { startSec: 0, endSec: 1 } };
  for (let i = 0; i < 4; i++) {
    const refused = await h.retrieval.call(h.lease.token, "transcribe_audio", args);
    assert.deepEqual(refused.result, { unavailable: true, reason: "Local speech recognition unavailable: a word has no usable timing or an unresolved pause." + left(4 - i, 15 - 2 * i) });
    const answered = await h.retrieval.call(h.lease.token, "transcribe_audio", args);
    assert.equal(answered.receipt.status, "complete");
    assert.deepEqual((answered.result as { remaining: unknown }).remaining, { speechCalls: 3 - i, mediaCalls: 14 - 2 * i, listeningCalls: 2, images: 24 });
  }
  await assert.rejects(h.retrieval.call(h.lease.token, "transcribe_audio", args), /four speech recognition calls\. Left in this run: 0 speech, 8 media/);
  assert.equal(reads, 8); assert.equal((await h.loaded())!.mediaReceipts!.length, 4);
});

test("film sound is read in stretches through leased MCP: timed where its words can be placed, text alone where they cannot", async () => {
  const heardSeconds: number[] = [];
  const h = await harness({ sound: filmSound([[1, 2], [6, 7]]), speechText: async () => "  Not yet.\n",
    speech: async bytes => {
      const seconds = (bytes.length - 44) / 32000; heardSeconds.push(seconds);
      // The whole ten seconds, with its four-second pause, is what the measured reader refuses; so is the second line here.
      if (seconds > 5 || heardSeconds.length === 2) throw unplaced();
      return { ...speechAnswer, seconds };
    } });
  const server = new WorldQueryServer(() => h.store); await server.start(); closeOnCleanup(() => server.stop());
  server.attachLease(h.lease.token, { retrieval: h.retrieval, onReceipt: () => {} });
  const response = await fetch(server.leasedUrl(h.lease.token)!, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "transcribe_audio", arguments: { source: h.source, range: { startSec: 0, endSec: 10 } } } }) });
  const body = await response.json() as { result: { content: Array<{ type: string; text?: string }> } };
  const { remaining, ...observed } = JSON.parse(body.result.content[0]!.text!);
  assert.deepEqual(observed.transcript.stretches.map((stretch: { read: string; text: string; startSec: number; viewEndSec: number }) => [stretch.read, stretch.text, stretch.startSec, stretch.viewEndSec]),
    [["timed", "Stay here", .7, 2.3], ["text-only", "Not yet.", 5.7, 7.3]]);
  assert.equal(observed.transcript.text, "Stay here Not yet."); assert.deepEqual(observed.transcript.words.map((word: { text: string }) => word.text), ["Stay", "here"]);
  assert.ok(Math.abs(observed.transcript.words[0].sourceStartSec - .8) < 1e-9, "a word's time is the interval's, not its stretch's");
  assert.deepEqual(heardSeconds.map(seconds => Math.round(seconds * 1000) / 1000), [1.6, 1.6], "neither reader was given the pause");
  assert.deepEqual(remaining, { speechCalls: 3, mediaCalls: 15, listeningCalls: 2, images: 24 });
  assert.match(observed.limitations.join(" "), /sound outside them was not read/); assert.match(observed.limitations.join(" "), /text-only stretch/);
  assert.deepEqual((await h.loaded())!.mediaReceipts![0]!.media, observed, "the receipt keeps the evidence, not the budgets");
  assert.equal(h.store.getBundle().meta.schemaVersion, 150);
});

test("an interval with no voice in it completes with no stretches, calls no reader and spends no speech call", async () => {
  let calls = 0;
  const h = await harness({ sound: (start, end) => new Float32Array(Math.round((end - start) * 16000)),
    speech: async () => { calls++; return speechAnswer; }, speechText: async () => { calls++; return "invented"; } });
  const args = { source: h.source, range: { startSec: 0, endSec: 1 } };
  for (let i = 0; i < 5; i++) {
    const outcome = i % 2 ? await h.retrieval.call(h.lease.token, "review_audio_content", { ...args, expectedText: "Stay here" }) : await h.retrieval.call(h.lease.token, "transcribe_audio", args);
    const transcript = outcome.receipt.media!.transcript!;
    assert.equal(outcome.receipt.status, "complete"); assert.deepEqual(transcript.stretches, []); assert.equal(transcript.text, ""); assert.equal(transcript.engine, undefined);
    assert.equal(transcript.contentReview?.comparison.status, i % 2 ? "compared" : undefined, "a review of nothing heard still carries its comparison");
    assert.deepEqual((outcome.result as { remaining: unknown }).remaining, { speechCalls: 4, mediaCalls: 15 - i, listeningCalls: 2, images: 24 });
  }
  assert.equal(calls, 0); assert.equal((await h.loaded())!.mediaReceipts!.length, 5);
});

for (const [name, speech, reason] of [
  ["timeout", async () => { throw new VoxaTimeoutError("stt", 12345); }, "Local speech recognition exceeded its time limit."],
  ["cancel", async () => { throw new VoxaCancelledError("stt"); }, "Local speech recognition was stopped."],
  ["deadline", async () => { throw new Error("Speech recognition was stopped or exceeded its deadline"); }, "Local speech recognition was stopped or exceeded its time limit."],
  ["duration", async () => ({ ...speechAnswer, seconds: 4 }), "The recognizer returned timing for a different recording duration."],
  ["malformed", async () => ({ ...speechAnswer, words: [] }), "Local speech recognition could not be completed or its response was invalid."],
  ["unknown", async () => { throw new Error("PRIVATE transcript /secret/path " + "x".repeat(10000)); }, "Local speech recognition could not be completed or its response was invalid."],
] as const) test(`speech ${name} keeps a safe stage-specific refusal without claiming a decode failure`, async () => {
  const h = await harness({ speech });
  const outcome = await h.retrieval.call(h.lease.token, "transcribe_audio", { source: h.source, range: { startSec: 0, endSec: 1 } });
  assert.deepEqual(outcome.result, { unavailable: true, reason: reason + left(4, 15) });
  assert.equal(outcome.receipt.status, "unavailable"); assert.equal((await h.loaded())!.mediaReceipts, undefined);
});

test("a plain reader that fails too, or runs past its bounds, leaves the measured reader's own safe refusal", async () => {
  for (const speechText of [async () => { throw new Error("PRIVATE transcript /secret/path"); }, async () => "x".repeat(12001)]) {
    const h = await harness({ speech: async () => { throw unplaced(); }, speechText });
    const outcome = await h.retrieval.call(h.lease.token, "transcribe_audio", { source: h.source, range: { startSec: 0, endSec: 1 } });
    assert.deepEqual(outcome.result, { unavailable: true, reason: "Local speech recognition unavailable: a word has no usable timing or an unresolved pause." + left(4, 15) });
  }
});

test("an unknown host failure is neutral while a listener failure names only the listening stage", async () => {
  let speechCalls = 0;
  const broken = await harness({ duringProbe: async () => { throw new Error("PRIVATE decoder path"); }, speech: async () => { speechCalls++; return speechAnswer; } });
  const failed = await broken.retrieval.call(broken.lease.token, "transcribe_audio", { source: broken.source, range: { startSec: 0, endSec: 1 } });
  assert.deepEqual(failed.result, { unavailable: true, reason: "Media inspection could not be completed, or inspection was stopped." + left(4, 15) });
  assert.equal(speechCalls, 0);
  const listening = await harness({ listener: { ...listener, listen: async () => { throw new Error("PRIVATE model output"); } } });
  const result = await listening.retrieval.call(listening.lease.token, "listen_audio", { source: listening.source, range: { startSec: 0, endSec: 1 }, focuses: ["voice-delivery"] });
  assert.deepEqual(result.result, { unavailable: true, reason: "Local audio listening could not be completed or its response was invalid." + left(4, 15, 1) });
  assert.equal((await listening.loaded())!.mediaReceipts, undefined);
});

test("cancellation during recognition overrides a coincident recognizer validation error", async () => {
  let h: Awaited<ReturnType<typeof harness>>;
  h = await harness({ speech: async () => { h.stop.abort(); throw new Error("Recognizer duration does not match the derivative"); } });
  const result = await h.retrieval.call(h.lease.token, "transcribe_audio", { source: h.source, range: { startSec: 0, endSec: 1 } });
  assert.deepEqual(result.result, { unavailable: true, reason: "Local speech recognition was stopped." }, "a stopped run is told of no budget: it has nothing left to plan");
  assert.equal((await h.loaded())!.mediaReceipts, undefined);
});

test("local listening serves subjective music/emotion/delivery text through leased MCP and replays schema 81 without audio bytes", async () => {
  let calls = 0;
  const h = await harness({ allowed: false, supported: false, listener: { ...listener, listen: async (bytes, focuses) => {
    calls++; assert.ok(bytes.length > 32000); assert.deepEqual(focuses, ["music", "emotion", "voice-delivery"]); return listeningAnswer;
  } } });
  const server = new WorldQueryServer(() => h.store); await server.start(); closeOnCleanup(() => server.stop());
  server.attachLease(h.lease.token, { retrieval: h.retrieval, onReceipt: () => {} });
  const response = await fetch(server.leasedUrl(h.lease.token)!, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "listen_audio", arguments: { source: h.source,
      range: { startSec: 3, endSec: 4 }, focuses: ["music", "emotion", "voice-delivery"] } } }) });
  const body = await response.json() as { result: { content: Array<{ type: string; text?: string }> } };
  assert.equal(calls, 1); assert.ok(body.result.content.every(content => content.type === "text"));
  const { remaining, ...result } = JSON.parse(body.result.content[0]!.text!);
  assert.equal(result.coverage, "model-audio-listening"); assert.equal(result.listening.review, listeningAnswer.review);
  assert.deepEqual(result.range, { startSec: 3, endSec: 4 }); assert.equal(result.listening.streamIndex, 1);
  assert.deepEqual(remaining, { speechCalls: 4, mediaCalls: 15, listeningCalls: 1, images: 24 });
  assert.equal(h.store.getBundle().meta.schemaVersion, 81); await assert.rejects(readWorldMeta(h.store.dir, { supports: 80 }), /newer Arke/);
  const loaded = (await h.loaded())!;
  assert.deepEqual(loaded.mediaReceipts![0]!.media, result); assert.equal(loaded.imageDisclosures, undefined);
  assert.ok(!JSON.stringify(loaded.mediaReceipts).includes("base64"));
});

test("unavailable listening refuses before decoding/budgets, recovers, and retains its separate two-call limit", async () => {
  const absent = await harness();
  assert.equal((await absent.retrieval.call(absent.lease.token, "listen_audio", { source: absent.source, range: { startSec: 0, endSec: 1 }, focuses: ["music"] })).receipt.status, "unavailable");
  assert.equal(absent.counts().snapshots, 0);
  let ready = false;
  const h = await harness({ listener: { ...listener, ready: async () => ready } }), before = h.store.getBundle().meta.schemaVersion;
  const args = { source: h.source, range: { startSec: 0, endSec: 1 }, focuses: ["music"] };
  for (let i = 0; i < 17; i++) assert.equal((await h.retrieval.call(h.lease.token, "listen_audio", args)).receipt.status, "unavailable");
  assert.equal(h.counts().snapshots, 0); assert.equal(h.store.getBundle().meta.schemaVersion, before); assert.equal((await h.loaded())!.mediaReceipts, undefined);
  ready = true;
  for (let i = 0; i < 2; i++) assert.equal((await h.retrieval.call(h.lease.token, "listen_audio", args)).receipt.status, "complete");
  await assert.rejects(h.retrieval.call(h.lease.token, "listen_audio", args), /two audio listening/);
});

for (const revoke of ["abort", "world", "lease", "close", "bytes", "publish"] as const) test(`listening cannot deliver evidence after ${revoke} changes`, async () => {
  let h: Awaited<ReturnType<typeof harness>>;
  const revokeAccess = async () => {
    if (revoke === "abort" || revoke === "publish") h.stop.abort();
    else if (revoke === "world") h.setActive(null);
    else if (revoke === "lease") h.leases.revokeRun(h.lease.runId);
    else if (revoke === "close") await h.store.close();
    else await writeFile(join(h.store.dir, "artifacts", "inspect.mp4"), "changed");
  };
  h = await harness({ listener: { ...listener, listen: async () => { if (revoke !== "publish") await revokeAccess(); return listeningAnswer; } },
    ...(revoke === "publish" ? { duringPublish: revokeAccess } : {}) });
  try { assert.equal((await h.retrieval.call(h.lease.token, "listen_audio", { source: h.source, range: { startSec: 0, endSec: 1 }, focuses: ["emotion"] })).receipt.status, "unavailable"); }
  catch (error) { assert.ok(error instanceof LeaseDeniedError); }
  if (revoke !== "publish") assert.equal((await h.loaded())!.mediaReceipts, undefined);
});

test("listening requires explicit ambiguous streams and validates interval/focus before invoking the worker", async () => {
  let calls = 0;
  const h = await harness({ listener: { ...listener, listen: async () => { calls++; return listeningAnswer; } },
    inventory: { ...inventory, streams: [...inventory.streams, { ...inventory.streams[1]!, index: 2 }] } });
  await assert.rejects(h.retrieval.call(h.lease.token, "listen_audio", { source: h.source, range: { startSec: 0, endSec: 1 }, focuses: ["music"] }), /explicit audio/);
  await assert.rejects(h.retrieval.call(h.lease.token, "listen_audio", { source: h.source, range: { startSec: 0, endSec: 31 }, focuses: ["music"] }), /valid interval/);
  assert.equal(calls, 0);
});

test("local speech receipts replay with schema 150, their stretches and source/view times, without image permission or raw audio", async () => {
  const h = await harness({ allowed: false, supported: false, speech: async () => speechAnswer });
  const outcome = await h.retrieval.call(h.lease.token, "transcribe_audio", { source: h.source, range: { startSec: 3, endSec: 4 } });
  assert.equal(outcome.receipt.status, "complete"); assert.equal(outcome.receipt.media!.coverage, "recognized-speech");
  assert.equal(outcome.receipt.media!.transcript!.words[0]!.sourceStartSec, 3.1);
  assert.deepEqual(outcome.receipt.media!.transcript!.stretches, [{ startSec: 0, endSec: 1, viewStartSec: 3, viewEndSec: 4, read: "timed", text: "Stay here" }]);
  assert.equal(outcome.imageContent, undefined); assert.equal((await h.loaded())!.imageDisclosures, undefined);
  const persisted = (await h.loaded())!.mediaReceipts![0]!;
  assert.deepEqual(persisted, outcome.receipt); assert.equal(h.store.getBundle().meta.schemaVersion, 150);
  // A build from before stretches holds a transcript to one timed read, so it must refuse the world rather than its journal.
  await assert.rejects(readWorldMeta(h.store.dir, { supports: 149 }), /newer Arke/);
  assert.equal(JSON.stringify(outcome.result).includes("base64"), false);
});

test("speech-content review returns a script-bound wording diff as evidence for the agent's semantic interpretation", async () => {
  const h = await harness({ speech: async () => speechAnswer });
  const server = new WorldQueryServer(() => h.store); await server.start(); closeOnCleanup(() => server.stop());
  server.attachLease(h.lease.token, { retrieval: h.retrieval, onReceipt: () => {} });
  const response = await fetch(server.leasedUrl(h.lease.token)!, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "review_audio_content",
      arguments: { source: h.source, range: { startSec: 0, endSec: 1 }, expectedText: "Do not stay here" } } }) });
  const result = await response.json() as { result: { content: Array<{ type: string; text?: string }> } };
  assert.ok(result.result.content.every(block => block.type === "text"));
  const receipt = (await h.loaded())!.mediaReceipts![0]!, review = receipt.media!.transcript!.contentReview!;
  assert.equal(receipt.tool, "review-audio-content"); assert.equal(review.expectedText, "Do not stay here");
  assert.equal(review.comparison.status === "compared" && review.comparison.result, "mismatch");
  assert.ok(receipt.media!.limitations.some(text => text.includes("untrusted")));
});

test("missing speech runtime fails before decoding and does not raise the world schema", async () => {
  const h = await harness(), before = h.store.getBundle().meta.schemaVersion;
  const result = await h.retrieval.call(h.lease.token, "transcribe_audio", { source: h.source, range: { startSec: 0, endSec: 1 } });
  assert.equal(result.receipt.status, "unavailable"); assert.equal(h.counts().snapshots, 0);
  assert.equal(h.store.getBundle().meta.schemaVersion, before); assert.equal((await h.loaded())!.mediaReceipts, undefined);
});

test("a configured reader with an offline runtime refuses before decoding or budgets and recovers in the same conversation", async () => {
  let ready = false, calls = 0;
  const h = await harness({ speechReady: async signal => { signal.throwIfAborted(); return ready; }, speech: async () => { calls++; return speechAnswer; } });
  const args = { source: h.source, range: { startSec: 0, endSec: 1 } }, before = h.store.getBundle().meta.schemaVersion;
  for (let i = 0; i < 17; i++) assert.equal((await h.retrieval.call(h.lease.token, "transcribe_audio", args)).receipt.status, "unavailable");
  assert.equal(h.counts().snapshots, 0); assert.equal(calls, 0); assert.equal(h.store.getBundle().meta.schemaVersion, before);
  ready = true;
  for (let i = 0; i < 4; i++) assert.equal((await h.retrieval.call(h.lease.token, "transcribe_audio", args)).receipt.status, "complete");
  assert.equal(calls, 4);
  await assert.rejects(h.retrieval.call(h.lease.token, "transcribe_audio", args), /four speech/);
});

test("speech stream ambiguity, invalid references and per-run recognition budget are enforced", async () => {
  const h = await harness({ speech: async () => speechAnswer, inventory: { ...inventory, streams: [...inventory.streams, { ...inventory.streams[1]!, index: 2 }] } });
  await assert.rejects(h.retrieval.call(h.lease.token, "transcribe_audio", { source: h.source, range: { startSec: 0, endSec: 1 } }), /explicit audio/);
  await assert.rejects(h.retrieval.call(h.lease.token, "review_audio_content", { source: h.source, range: { startSec: 0, endSec: 1 }, expectedText: "" }), /valid interval/);
  // The ambiguous call above was never answered, so all four speech reads are still to come.
  for (let i = 0; i < 4; i++) assert.equal((await h.retrieval.call(h.lease.token, "transcribe_audio", { source: h.source, range: { startSec: 0, endSec: 1 }, streamIndex: 2 })).receipt.status, "complete");
  await assert.rejects(h.retrieval.call(h.lease.token, "transcribe_audio", { source: h.source, range: { startSec: 0, endSec: 1 }, streamIndex: 2 }), /four speech/);
});

for (const revoke of ["abort", "world", "lease", "close", "bytes"] as const) test(`speech evidence cannot finish after ${revoke} changes during recognition`, async () => {
  let h: Awaited<ReturnType<typeof harness>>;
  h = await harness({ speech: async () => {
    if (revoke === "abort") h.stop.abort();
    else if (revoke === "world") h.setActive(null);
    else if (revoke === "lease") h.leases.revokeRun(h.lease.runId);
    else if (revoke === "close") await h.store.close();
    else await writeFile(join(h.store.dir, "artifacts", "inspect.mp4"), "changed");
    return speechAnswer;
  } });
  try { assert.equal((await h.retrieval.call(h.lease.token, "transcribe_audio", { source: h.source, range: { startSec: 0, endSec: 1 } })).receipt.status, "unavailable"); }
  catch (error) { assert.ok(error instanceof LeaseDeniedError); }
  assert.equal((await h.loaded())!.mediaReceipts, undefined);
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
test("cloud image revocation during publication withholds every frame block", async () => {
  let h: Awaited<ReturnType<typeof harness>>; h = await harness({ duringPublish: async () => { h.forbid(); } });
  const result = await h.retrieval.call(h.lease.token, "sample_video", { source: h.source, range: { startSec: 0, endSec: 1 } });
  assert.equal(result.receipt.status, "unavailable"); assert.equal(result.imageContent, undefined);
});
test("portrait footage uses the same pixel and edge limits as landscape footage", async () => {
  const h = await harness({ inventory: { ...inventory, streams: [{ ...inventory.streams[0]!, width: 2160, height: 3840 }] } });
  const result = await h.retrieval.call(h.lease.token, "sample_video", { source: h.source, range: { startSec: 0, endSec: 1 }, count: 1 });
  assert.equal(result.receipt.status, "complete"); assert.equal(result.receipt.media!.probeVersion, "ffprobe version fixture");
});
test("the shared leased MCP catalog serves frame images as image blocks and records the matching receipt", async () => {
  const h = await harness(), server = new WorldQueryServer(() => h.store); await server.start(); closeOnCleanup(() => server.stop());
  let served = ""; server.attachLease(h.lease.token, { retrieval: h.retrieval, onReceipt: receipt => { served = receipt.tool; } });
  const rpc = async (method: string, params?: unknown) => (await fetch(server.leasedUrl(h.lease.token)!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  const listed = await rpc("tools/list") as { result: { tools: Array<{ name: string }> } };
  for (const name of ["inspect_media", "sample_video", "analyze_audio_signal", "transcribe_audio", "review_audio_content"]) assert.ok(listed.result.tools.some((tool: { name: string }) => tool.name === name));
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
test("with fewer images left than asked for, sample_video samples what is left across the interval; with none left it refuses before a media call is spent", async () => {
  const h = await harness({ local: true }), args = { source: h.source, range: { startSec: 0, endSec: 8 } };
  for (const count of [8, 8, 5]) assert.equal((await h.retrieval.call(h.lease.token, "sample_video", { ...args, count })).receipt.status, "complete");
  // Three left of 24. Eight frames used to be decoded, three counted, and the fourth refused the whole call.
  const last = await h.retrieval.call(h.lease.token, "sample_video", { ...args, count: 8 });
  assert.equal(last.receipt.status, "complete"); assert.equal(last.imageContent!.length, 3);
  assert.deepEqual(last.receipt.media!.frames!.map(frame => frame.sourceTimeSec), [0, 8 / 3, 16 / 3], "spread over the interval, not the first three of eight");
  assert.match(last.receipt.media!.limitations.join(" "), /Asked for 8 frames; 3 were sampled/);
  assert.deepEqual((last.result as { remaining: unknown }).remaining, { speechCalls: 4, mediaCalls: 12, listeningCalls: 2, images: 0 });
  const refused = await h.retrieval.call(h.lease.token, "sample_video", args);
  assert.deepEqual(refused.result, { unavailable: true, reason: "sample_video: this run has reached its 24-image inspection limit." + left(4, 12, 2, 0) });
  assert.equal(h.counts().frames, 24, "nothing was decoded for the refused call"); assert.equal((await h.loaded())!.mediaReceipts!.length, 4);
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
  const h = await harness({ listener, speech: async () => speechAnswer }), production = h.store.getBundle().productions.find(value => value.meta.id === "saltlight")!, base = production.takes.find(take => take.kind === "clip")!;
  const parentId = newId("tk"), segmentId = newId("tk"), parent: Take = { ...base, id: parentId, media: "source.mp4", mediaHash: hash(png) };
  const segment: Take = { ...base, id: segmentId, segment: { passTakeId: parentId, inSec: 2, outSec: 5 } }; delete segment.media; delete segment.mediaHash;
  await h.store.commit({ kind: "segment-fixture", source: "test", files: [
    { path: `productions/saltlight/takes/${parentId}/source.mp4`, action: "create", baseHash: null, encoding: "base64", content: Buffer.from(png).toString("base64") },
    ...[parent, segment].map(take => ({ path: `productions/saltlight/takes/${take.id}/take.json`, action: "create" as const, baseHash: null, content: JSON.stringify(take) })),
  ] });
  const outcome = await h.retrieval.call(h.lease.token, "sample_video", { source: { kind: "production-take", productionId: "saltlight", takeId: segmentId }, range: { startSec: .5, endSec: 1.5 }, count: 1 });
  assert.equal(outcome.receipt.media!.frames![0]!.sourceTimeSec, 2.5); assert.equal(outcome.receipt.media!.frames![0]!.viewTimeSec, .5);
  const speech = await h.retrieval.call(h.lease.token, "transcribe_audio", { source: { kind: "production-take", productionId: "saltlight", takeId: segmentId }, range: { startSec: .5, endSec: 1.5 } });
  assert.equal(speech.receipt.media!.transcript!.words[0]!.sourceStartSec, 2.6);
  assert.equal(speech.receipt.media!.transcript!.words[0]!.viewStartSec, .6);
  const listening = await h.retrieval.call(h.lease.token, "listen_audio", { source: { kind: "production-take", productionId: "saltlight", takeId: segmentId }, range: { startSec: .5, endSec: 1.5 }, focuses: ["voice-delivery"] });
  assert.equal(listening.receipt.media!.sourceStartSec, 2); assert.deepEqual(listening.receipt.media!.range, { startSec: .5, endSec: 1.5 });
  assert.equal(listening.receipt.media!.listening!.derivative.durationSec, 1);
});
test("take-review coverage requires served evidence in its completed run and still-current source bytes", async () => {
  const h = await harness({ listener, speech: async () => speechAnswer }), production = h.store.getBundle().productions.find(value => value.meta.id === "saltlight")!, base = production.takes.find(take => take.kind === "clip")!;
  const take: Take = { ...base, id: newId("tk"), media: "review.mp4", mediaHash: hash(png) }, path = `productions/saltlight/takes/${take.id}/review.mp4`;
  await h.store.commit({ kind: "review-media-fixture", source: "test", files: [
    { path, action: "create", baseHash: null, encoding: "base64", content: Buffer.from(png).toString("base64") },
    { path: `productions/saltlight/takes/${take.id}/take.json`, action: "create", baseHash: null, content: JSON.stringify(take) },
  ] });
  const source = { kind: "production-take", productionId: "saltlight", takeId: take.id }, range = { startSec: 0, endSec: 1 };
  const frames = await h.retrieval.call(h.lease.token, "sample_video", { source, range, count: 1 }), audio = await h.retrieval.call(h.lease.token, "analyze_audio_signal", { source, range });
  const speech = await h.retrieval.call(h.lease.token, "review_audio_content", { source, range, expectedText: "Stay here" });
  const at = "2026-10-13T00:00:00Z", turnId = newId("turn"), intent: ConversationActionPrepareIntent = {
    actionId: newId("act"), conversationId: h.cv, turnId, worldId: h.store.worldId, productionId: "saltlight", actorId: LOCAL_ACTOR_ID,
    scope: "production", actionKind: "production-take-review", authorityKind: "take-review", cardFamily: "take-review", targets: [{ kind: "take", id: take.id }],
    payloadDigest: hash(png), baseObservations: [], dependencies: [], createdAt: at,
  };
  assert.match(await takeReviewInspectionReason(h.store, intent, production, take), /Metadata-only/);
  const chat = new WorldChatStore(conversationDir(h.store.dir, h.cv));
  await chat.append({ type: "turn.completed", message: { id: newId("msg"), turnId, role: "studio", text: "Review", attachmentIds: [], createdAt: at },
    run: { id: h.lease.runId, turnId, basedOnConversationSeq: 1, status: "completed", adapter: "fixture", harnessCleanup: "not-required", contextDigest: hash(png), startedAt: at, endedAt: at },
    receipts: [frames.receipt, frames.receipt, audio.receipt, speech.receipt], candidates: [], groups: [], tombstones: [], actionPrepareIntents: [intent] });
  const reason = await takeReviewInspectionReason(h.store, intent, production, take);
  assert.match(reason, /1 unique timestamped still frames/); assert.match(reason, /Original-channel audio sample measurements/); assert.match(reason, /no listening or performance judgment/);
  assert.match(reason, /Local automatic speech transcript supplied/); assert.match(reason, /emotion and delivery were not reviewed/);
  const listening = await h.retrieval.call(h.lease.token, "listen_audio", { source, range, focuses: ["voice-delivery"] });
  assert.match(await takeReviewInspectionReason(h.store, intent, production, take), /emotion and delivery were not reviewed/, "evidence not served in the completed turn cannot establish listening coverage");
  await chat.append({ type: "turn.completed", message: { id: newId("msg"), turnId, role: "studio", text: "Updated review", attachmentIds: [], createdAt: at },
    run: { id: h.lease.runId, turnId, basedOnConversationSeq: 1, status: "completed", adapter: "fixture", harnessCleanup: "not-required", contextDigest: hash(png), startedAt: at, endedAt: at },
    receipts: [listening.receipt], candidates: [], groups: [], tombstones: [], actionPrepareIntents: [intent] });
  const listened = await takeReviewInspectionReason(h.store, intent, production, take);
  assert.match(listened, /Local audio-model impressions supplied for source 0–1s \(voice-delivery\)/);
  assert.match(listened, /Other intervals and focuses remain unreviewed/); assert.doesNotMatch(listened, /Audio was not inspected|emotion and delivery were not reviewed/);
  await writeFile(join(h.store.dir, path), "changed");
  assert.match(await takeReviewInspectionReason(h.store, intent, production, take), /Metadata-only/);
});


const performanceBytes = wav(Array(48000).fill(0));
async function addPerformance(h: Awaited<ReturnType<typeof harness>>) {
  const at = "2026-10-21T00:00:00Z", id = newId("pf"), production = h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!;
  const scene = production.scenes.find(scene => orderedShots(scene).some(shot => resolvePerformanceLine(scene, shot.id).ok))!;
  const shot = orderedShots(scene).find(shot => resolvePerformanceLine(scene, shot.id).ok)!, line = resolvePerformanceLine(scene, shot.id);
  if (!line.ok) throw new Error("fixture line");
  const outputHash = hash(performanceBytes), report = analyzePcmWav(performanceBytes, at);
  const record = ScratchPerformanceSchema.parse({ id, kind: "scratch", createdAt: at, recordedAt: at,
    target: { productionId: production.meta.id, sceneId: scene.id, sceneVersion: scene.version, shotId: shot.id,
      speakerSheetId: line.speakerSheetId, ...(line.blockId ? { blockId: line.blockId } : {}), authoredTextHash: hash(Buffer.from(line.text)) },
    file: outputHash.replace(":", "-") + ".wav", captureAcknowledgement: { basis: "self", statementVersion: 1, at },
    provenance: { schemaVersion: 1, source: { kind: "performance-recording", productionId: production.meta.id, performanceId: id, sourceFile: "source.wav", sourceMediaHash: outputHash },
      sourceTechnical: report.technical, outputHash, outputTechnical: report.technical, preparation: [], qualityReport: report, createdAt: at } });
  const prefix = `productions/${production.meta.id}/performances/${id}`;
  await h.store.commit({ kind: "performance-media-fixture", source: "test", files: [
    { path: prefix + "/performance.json", action: "create", baseHash: null, content: JSON.stringify(record) },
    { path: prefix + "/" + record.file, action: "create", baseHash: null, encoding: "base64", content: Buffer.from(performanceBytes).toString("base64") },
  ] });
  return { source: { kind: "performance" as const, productionId: production.meta.id, performanceId: id }, path: prefix + "/" + record.file,
    record: h.store.getBundle().productions.find(p => p.meta.id === production.meta.id)!.performances.find(p => p.id === id)! };
}

test("an exact saved performance is inspectable independently of review/selection and its receipt replays at boundary 104", async () => {
  const h = await harness({ sourceBytes: performanceBytes }), performance = await addPerformance(h);
  const server = new WorldQueryServer(() => h.store); await server.start(); closeOnCleanup(() => server.stop());
  let servedSource: unknown; server.attachLease(h.lease.token, { retrieval: h.retrieval, onReceipt: receipt => { servedSource = receipt.media?.source; } });
  const response = await fetch(server.leasedUrl(h.lease.token)!, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inspect_media", arguments: { source: performance.source } } }) });
  const reply = await response.json() as { result: { content: Array<{ type: string; text: string }> } };
  assert.ok(reply.result.content.every(value => value.type === "text"));
  const { remaining, ...result } = JSON.parse(reply.result.content[0]!.text);
  assert.deepEqual(result.source, performance.source); assert.deepEqual(servedSource, performance.source);
  assert.equal(result.sourceHash, performance.record.provenance.outputHash);
  assert.deepEqual(remaining, { speechCalls: 4, mediaCalls: 15, listeningCalls: 2, images: 24 });
  assert.equal(h.store.getBundle().meta.schemaVersion, 104);
  assert.deepEqual((await h.loaded())!.mediaReceipts![0]!.media, result);
  await assert.rejects(readWorldMeta(h.store.dir, { supports: 103 }), /newer|version|schema/i);
  assert.deepEqual(h.store.getBundle().productions.find(p => p.meta.id === "saltlight")!.performanceReview.selections, {});
});

for (const failure of ["missing-record", "wrong-production", "missing-file", "changed-bytes", "target-owner", "unsafe-file"] as const) test(`performance media refuses ${failure} without advancing its reader boundary`, async () => {
  const h = await harness({ sourceBytes: performanceBytes }), performance = await addPerformance(h), before = h.store.getBundle().meta.schemaVersion;
  const source = { ...performance.source };
  if (failure === "missing-record") source.performanceId = newId("pf");
  if (failure === "wrong-production") source.productionId = "absent-production";
  if (failure === "missing-file") await rm(join(h.store.dir, performance.path));
  if (failure === "changed-bytes") await writeFile(join(h.store.dir, performance.path), "changed");
  if (failure === "target-owner") performance.record.target.productionId = "another-production";
  if (failure === "unsafe-file") performance.record.file = "../outside.wav";
  const outcome = await h.retrieval.call(h.lease.token, "inspect_media", { source });
  assert.equal(outcome.receipt.status, "unavailable"); assert.equal(h.store.getBundle().meta.schemaVersion, before);
  assert.equal((await h.loaded())!.mediaReceipts, undefined); assert.equal(h.counts().snapshots, 0);
});

for (const failure of ["identity", "bytes", "abort", "lease"] as const) test(`performance evidence cannot finish after ${failure} moves during decoding`, async () => {
  let h: Awaited<ReturnType<typeof harness>>, performance: Awaited<ReturnType<typeof addPerformance>>;
  h = await harness({ sourceBytes: performanceBytes, duringProbe: async () => {
    if (failure === "identity") performance.record.provenance.outputHash = hash(Buffer.from("different identity"));
    if (failure === "bytes") await writeFile(join(h.store.dir, performance.path), "changed");
    if (failure === "abort") h.stop.abort();
    if (failure === "lease") h.leases.revokeRun(h.lease.runId);
  } }); performance = await addPerformance(h); const before = h.store.getBundle().meta.schemaVersion;
  try { assert.equal((await h.retrieval.call(h.lease.token, "inspect_media", { source: performance.source })).receipt.status, "unavailable"); }
  catch (error) { assert.ok(error instanceof LeaseDeniedError); }
  assert.equal(h.store.getBundle().meta.schemaVersion, before); assert.equal((await h.loaded())!.mediaReceipts, undefined);
});

test("performance signal, speech and listening reuse the same per-run budgets as other sources", async () => {
  const h = await harness({ sourceBytes: performanceBytes, listener, speech: async () => speechAnswer }), performance = await addPerformance(h), range = { startSec: 0, endSec: 1 };
  const signal = await h.retrieval.call(h.lease.token, "analyze_audio_signal", { source: performance.source, range });
  assert.equal(signal.receipt.media!.coverage, "decoded-audio-samples");
  for (let i = 0; i < 4; i++) {
    const result = await h.retrieval.call(h.lease.token, "review_audio_content", { source: i % 2 ? h.source : performance.source, range, expectedText: "Stay here" });
    assert.equal(result.receipt.media!.coverage, "recognized-speech");
  }
  await assert.rejects(h.retrieval.call(h.lease.token, "transcribe_audio", { source: performance.source, range }), /four speech/);
  for (const source of [performance.source, h.source]) assert.equal((await h.retrieval.call(h.lease.token, "listen_audio", { source, range, focuses: ["voice-delivery"] })).receipt.media!.coverage, "model-audio-listening");
  await assert.rejects(h.retrieval.call(h.lease.token, "listen_audio", { source: performance.source, range, focuses: ["voice-delivery"] }), /two audio/);
  for (let i = 0; i < 9; i++) await h.retrieval.call(h.lease.token, "inspect_media", { source: i % 2 ? h.source : performance.source });
  await assert.rejects(h.retrieval.call(h.lease.token, "inspect_media", { source: performance.source }), /call budget/);
  assert.equal((await h.loaded())!.mediaReceipts!.length, 16);
  // A speech read's own boundary is above a performance's, and comes first: 104 would leave its stretches to a build that cannot read them.
  assert.equal(h.store.getBundle().meta.schemaVersion, 150);
});

test("a speech read of a performance or a finished film raises the world past its stretches, not only past its source", async () => {
  const p = await harness({ sourceBytes: performanceBytes, speech: async () => speechAnswer }), performance = await addPerformance(p);
  assert.equal((await p.retrieval.call(p.lease.token, "transcribe_audio", { source: performance.source, range: { startSec: 0, endSec: 1 } })).receipt.status, "complete");
  assert.equal(p.store.getBundle().meta.schemaVersion, 150);
  const e = await harness({ speech: async () => speechAnswer }), exported = await addExport(e);
  assert.equal((await e.retrieval.call(e.lease.token, "transcribe_audio", { source: exported.source, range: { startSec: 0, endSec: 1 } })).receipt.status, "complete");
  assert.equal(e.store.getBundle().meta.schemaVersion, 150);
});

async function addExport(h: Awaited<ReturnType<typeof harness>>, deliveryKind: "video" | "manuscript" | "audiobook-video" = "video", id = "ex_review") {
  const output = deliveryKind === "manuscript" ? `exports/${id}.pdf` : `exports/${id}.mp4`;
  await mkdir(join(h.store.dir, "exports"), { recursive: true }); await writeFile(join(h.store.dir, output), png);
  await recordCompletedExport(h.store, { id, worldId: h.store.worldId, productionId: "saltlight", status: "done", createdAt: "2026-11-10T00:00:00Z",
    output, deliveryKind, sourceFingerprint: "production-export-v1:source" });
  return { source: { kind: "export" as const, exportId: id }, path: join(h.store.dir, output) };
}

test("a finished film export is inspectable by its id and its receipt replays at boundary 128", async () => {
  const h = await harness(), film = await addExport(h);
  const outcome = await h.retrieval.call(h.lease.token, "inspect_media", { source: film.source });
  assert.deepEqual(outcome.receipt.media!.source, film.source); assert.equal(outcome.receipt.media!.sourceHash, hash(png));
  assert.match(outcome.receipt.querySummary!, /export:ex_review/);
  assert.equal(h.store.getBundle().meta.schemaVersion, 128);
  assert.deepEqual((await h.loaded())!.mediaReceipts![0]!.media, outcome.receipt.media);
  await assert.rejects(readWorldMeta(h.store.dir, { supports: 127 }), /newer|version|schema/i);
  const frames = await h.retrieval.call(h.lease.token, "sample_video", { source: film.source, range: { startSec: 0, endSec: 1 }, count: 1 });
  assert.equal(frames.receipt.media!.coverage, "sampled-frames-only");
});

for (const failure of ["unknown-id", "manuscript", "audiobook-video", "missing-file", "path"] as const) test(`export media refuses ${failure} without advancing its reader boundary`, async () => {
  const h = await harness(), film = await addExport(h, failure === "manuscript" || failure === "audiobook-video" ? failure : "video"), before = h.store.getBundle().meta.schemaVersion;
  if (failure === "missing-file") await rm(film.path);
  if (failure === "path") { await assert.rejects(h.retrieval.call(h.lease.token, "inspect_media", { source: { kind: "export", exportId: "../ex_review" } })); return; }
  const outcome = await h.retrieval.call(h.lease.token, "inspect_media", { source: failure === "unknown-id" ? { kind: "export", exportId: "ex_absent" } : film.source });
  assert.equal(outcome.receipt.status, "unavailable"); assert.equal(h.store.getBundle().meta.schemaVersion, before);
  assert.equal((await h.loaded())!.mediaReceipts, undefined); assert.equal(h.counts().snapshots, 0);
});

test("a film replaced while it is being read cannot produce a receipt", async () => {
  let path = ""; const h = await harness({ duringProbe: async () => { await writeFile(path, "changed"); } }), film = await addExport(h); path = film.path;
  const before = h.store.getBundle().meta.schemaVersion, outcome = await h.retrieval.call(h.lease.token, "inspect_media", { source: film.source });
  assert.equal(outcome.receipt.status, "unavailable"); assert.equal(h.store.getBundle().meta.schemaVersion, before);
  assert.equal((await h.loaded())!.mediaReceipts, undefined);
});
