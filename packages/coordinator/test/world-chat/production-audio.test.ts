import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { JobSchema, newId, orderedShots, ulid, storyTimelineFingerprint, performanceLineKey, type ConversationActionCard, type ModelWorldChatAction, type ProviderStatus, type WorldChatPreparedAction } from "@arke-studio/contracts";
import { productionAudioGenerationSource, productionAudioOperationId } from "../../src/world-chat/production-audio-generation.js";
import { GenerationQuotes } from "../../src/world-chat/generation-quotes.js";
import { generationCardResults } from "../../src/world-chat/generation-card-results.js";
import { worldChatActionAdapters } from "../../src/world-chat/actions.js";
import { WorldStore } from "../../src/world/store.js";
import { applyVoiceAssignment } from "../../src/sheets/authoring.js";
import { createAudioMediaTools } from "../../src/audio/media-tools.js";
import { audioHash } from "../../src/audio/qc.js";
import { pendingCharacterSampleReviews } from "../../src/audio/character-sample.js";
import { readPerformanceGenerationQuote, finalizeGeneratedPerformance } from "../../src/audio/performance-generation.js";
import { reviewPerformance } from "../../src/audio/performance-review.js";
import { freezeProductionPerformance, productionPerformanceBody, executeProductionPerformance } from "../../src/world-chat/production-performance.js";
import { applyTimelineCommand } from "../../src/productions/timeline.js";
import { freezeProductionAudioCue, executeProductionAudioCue } from "../../src/world-chat/production-audio-cue.js";
import { recordTakesFromJob } from "../../src/takes/arrival.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { SHIPPED_MANIFEST } from "../../../providers/src/manifest-data.js";
import { makeTempWorld } from "../world/helpers.js";
import { wav } from "../audio/helpers.js";
import { encodePng, solidImage } from "../../src/references/png.js";

// Now, not a date: performance-generation.ts holds a quote fresh for a day by the wall clock, so a
// fixed 2026-10-04 sealed quotes that every run from 2026-10-05 12:00 refused as stale.
const AT = new Date().toISOString();
const providers: ProviderStatus[] = [{ id: "google", configured: true, validation: "valid", fault: null, probes: [{ capability: "voice-tts", available: true }] }];
const action = (productionId: string, request: Extract<ModelWorldChatAction, { kind: "production-audio-generation" }>["request"]): ModelWorldChatAction =>
  ({ kind: "production-audio-generation", productionId, request, checkReceiptIds: [newId("check")] });

async function setup(providerRows: ProviderStatus[] = providers) {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => AT });
  await applyVoiceAssignment(store, { path: "characters/maren-kest.md", voice: { provider: "google", model: "gemini-3.8-flash-tts", voiceId: "Charon" } });
  const production = store.getBundle().productions.find(p => p.scenes.some(s => orderedShots(s).some(shot => shot.audio?.speaker === "maren-kest" && shot.audio.line)))!;
  const scene = production.scenes.find(s => orderedShots(s).some(shot => shot.audio?.speaker === "maren-kest" && shot.audio.line))!;
  const shot = orderedShots(scene).find(shot => shot.audio?.speaker === "maren-kest" && shot.audio.line)!;
  const inputs: EnqueueInput[] = [];
  const source = productionAudioGenerationSource(store, { manifest: structuredClone(SHIPPED_MANIFEST), settings: async () => null,
    providers: () => providerRows, jobs: () => [], reader: async () => {}, narrator: async () => null, freeze: input => input,
    tools: null, confirmUploads: async () => {} });
  const quotes = () => new GenerationQuotes(store, source, { enqueue: async input => { inputs.push(input); }, jobs: () => [] });
  return { store, production, scene, shot, source, inputs, quotes };
}

it("quotes the exact shot line and assigned voice without dispatch, refuses a changed voice and admits repeated approval once", async t => {
  const h = await setup(); t.after(() => h.store.close());
  const request = action(h.production.meta.id, { operation: "voice-line", shotId: h.shot.id, modelId: "gemini-3.8-flash-tts", delivery: "warm" });
  const id = newId("act");
  const body = await h.quotes().prepare(request, id, AT);
  assert.equal(body.medium, "audio"); assert.ok(body.estimatedMicroUsd! > 0);
  assert.match(body.prompt, /warm/i); assert.ok(body.options!.some(option => option.value.includes("Charon")));
  assert.equal(h.inputs.length, 0);
  assert.deepEqual(await h.quotes().prepare(request, id, AT), body, "a fresh service reads the sealed quote");
  await applyVoiceAssignment(h.store, { path: "characters/maren-kest.md", voice: { provider: "google", model: "gemini-3.8-flash-tts", voiceId: "Puck" } });
  await assert.rejects(h.quotes().dispatch(request, id), /changed/);
  assert.equal(h.inputs.length, 0);
  const fresh = newId("act"); await h.quotes().prepare(request, fresh, AT);
  await h.quotes().dispatch(request, fresh); await h.quotes().dispatch(request, fresh);
  assert.equal(h.inputs.length, 1); assert.equal(h.inputs[0]!.params.voiceId, "Puck");
  assert.equal(h.inputs[0]!.target.kind, "voice-line");
  assert.deepEqual(h.store.getBundle().productions.find(p => p.meta.id === h.production.meta.id)!.selections, h.production.selections);
});

it("places finalized PCM voice without a host probe, bounds its actual length and preserves dialogue", async t => {
  const h = await setup(); t.after(() => h.store.close());
  const id = newId("act"), request = action(h.production.meta.id, { operation: "voice-line", shotId: h.shot.id });
  await h.quotes().prepare(request, id, AT); await h.quotes().dispatch(request, id);
  const file = ".staging/voice-cue/speech.wav", bytes = wav(Array(48000).fill(1000));
  await mkdir(join(h.store.dir, ".staging/voice-cue"), { recursive: true }); await writeFile(join(h.store.dir, file), bytes);
  const { voiceReference: _voiceReference, ...input } = h.inputs[0]!;
  const job = JobSchema.parse({ ...input, id: newId("jb"), status: "succeeded", createdAt: AT, updatedAt: AT, landedFiles: [file] });
  const [take] = await recordTakesFromJob(h.store, job, null); await h.store.reload();
  assert.equal(take!.mediaHash, audioHash(bytes));
  await applyTimelineCommand(h.store, h.production.meta.id, { kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(h.store.getBundle().productions.find(p => p.meta.id === h.production.meta.id)!),
    commands: [{ kind: "add-track", trackId: "tr_dialogue", trackKind: "audio", name: "Dialogue", defaultRole: "dialogue" }] });
  const prepared = (role: "dialogue" | "music" = "dialogue", durationFrames = 12): Extract<WorldChatPreparedAction, { kind: "world-chat-production-audio-cue" }> => ({
    kind: "world-chat-production-audio-cue", worldId: h.store.worldId, ...freezeProductionAudioCue(h.store, h.production.meta.id),
    action: { kind: "production-audio-cue", productionId: h.production.meta.id, source: { kind: "take", takeId: take!.id }, trackId: "tr_dialogue", startFrame: 0,
      durationFrames, sourceInFrames: 0, gainDb: 0, role, checkReceiptIds: [] } });
  const card = () => ({ actionId: newId("act"), conversationId: newId("cv"), dependencies: [] }) as unknown as ConversationActionCard;
  await assert.rejects(executeProductionAudioCue(h.store, prepared("music"), card(), undefined, () => null), /dialogue role/);
  await assert.rejects(executeProductionAudioCue(h.store, prepared("dialogue", 240), card(), undefined, () => null), /shorter/);
  const cueCard = card();
  const outcome = await executeProductionAudioCue(h.store, prepared(), cueCard, undefined, () => null);
  assert.equal(outcome.status, "completed"); assert.equal(outcome.receipt?.kind, "editor-request");
  const retained = h.store.getBundle().productions.find(p => p.meta.id === h.production.meta.id)!.editorRequests.find(r => r.actionId === cueCard.actionId)!;
  assert.equal(retained.status, "pending"); assert.ok(retained.commands[0]?.kind === "place");
  assert.equal(retained.commands[0].clip.role, "dialogue");
});

it("uses the native single-line performance compiler and retains its stable quote only after approval", async t => {
  const h = await setup(); t.after(() => h.store.close());
  const id = newId("act"), request = action(h.production.meta.id, { operation: "performance", sceneId: h.scene.id, shotId: h.shot.id,
    direction: { speed: 1, cues: [], delivery: "warm", note: "quietly confident" } });
  const compiled = await h.source.compile(request, id, AT);
  assert.equal(compiled.inputs[0]!.target.id, `pf_${id.slice(4)}`);
  assert.match(String(compiled.inputs[0]!.params.instructions), /Quietly confident/i);
  await assert.rejects(readPerformanceGenerationQuote(h.store, productionAudioOperationId(id)));
  await h.quotes().prepare(request, id, AT); await h.quotes().dispatch(request, id);
  const retained = await readPerformanceGenerationQuote(h.store, productionAudioOperationId(id));
  assert.equal(retained.target.sceneVersion, h.scene.version); assert.equal(retained.createdAt, AT);
  assert.equal(h.inputs.length, 1); assert.equal(h.inputs[0]!.target.kind, "performance-generation");
  await assert.rejects(h.source.compile(action(h.production.meta.id, { operation: "performance", sceneId: h.scene.id, shotId: h.shot.id,
    direction: { speed: 0.8, cues: [] } }), newId("act"), AT), /speed/);
});

it("quotes table-read work through the native planner, including explicit unavailable lines", async t => {
  const h = await setup(); t.after(() => h.store.close());
  const compiled = await h.source.compile(action(h.production.meta.id, { operation: "table-read", sceneId: h.scene.id }), newId("act"), AT);
  assert.ok(compiled.inputs.length > 0);
  assert.ok(compiled.inputs.every(input => input.target.kind === "table-read-cache" && input.productionId === h.production.meta.id));
  assert.equal(compiled.body.quantity, compiled.inputs.length);
  assert.equal(new Set(compiled.inputs.map(input => input.idempotencyKey)).size, compiled.inputs.length);
  assert.equal(h.inputs.length, 0);
});

it("quotes local table-read lines with no provider charge and enqueues them only after approval", async t => {
  const h = await setup([...providers, { id: "kokoro", configured: true, validation: "valid", fault: null, probes: [{ capability: "voice-tts", available: true }] }]); t.after(() => h.store.close());
  await applyVoiceAssignment(h.store, { path: "characters/maren-kest.md", voice: { provider: "kokoro", model: "kokoro-82m", voiceId: "af_bella" } });
  const id = newId("act"), request = action(h.production.meta.id, { operation: "table-read", sceneId: h.scene.id });
  const body = await h.quotes().prepare(request, id, AT);
  assert.equal(h.inputs.length, 0); assert.equal(body.estimatedMicroUsd, 0); assert.equal(body.cost, "No provider charge");
  await h.quotes().dispatch(request, id); await h.quotes().dispatch(request, id);
  assert.ok(h.inputs.length > 0); assert.ok(h.inputs.every(input => input.provider === "kokoro" && input.target.kind === "table-read-cache"));
});

it("quotes a speaking sample with its exact script and photo, refuses a changed photo and keeps assignment human", async t => {
  const h = await setup([...providers, { id: "fal", configured: true, validation: "valid", fault: null, probes: [{ capability: "video", available: true }] }]); t.after(() => h.store.close());
  const kit = h.store.getBundle().referenceKits.find(kit => kit.sheetId === "maren-kest")!;
  const photo = kit.mainPhoto?.file ?? kit.anchor!;
  await writeFile(join(h.store.dir, "references/maren-kest", photo), encodePng(solidImage(2, 2, [40, 60, 90, 255])));
  const request = action(h.production.meta.id, { operation: "voice-sample", sheetId: "maren-kest", modelId: "seedance-2.0", script: "The water remembers.", durationSec: 5 });
  const id = newId("act"), body = await h.quotes().prepare(request, id, AT);
  assert.equal(body.medium, "video"); assert.match(body.prompt, /Speak exactly.*script:\nThe water remembers/s);
  assert.ok(body.references.some(reference => reference.role.includes("photo"))); assert.equal(h.inputs.length, 0);
  await writeFile(join(h.store.dir, "references/maren-kest", photo), encodePng(solidImage(2, 2, [90, 60, 40, 255])));
  await assert.rejects(h.quotes().dispatch(request, id), /changed/); assert.equal(h.inputs.length, 0);
  const fresh = newId("act"); await h.quotes().prepare(request, fresh, AT); await h.quotes().dispatch(request, fresh);
  assert.equal(h.inputs.length, 1); assert.equal(h.inputs[0]!.params.referenceScript, "The water remembers.");
  assert.equal(h.inputs[0]!.target.kind, "character-voice-sample");
  assert.deepEqual(h.store.getBundle().referenceKits.find(kit => kit.sheetId === "maren-kest"), kit);
});

it("keeps generated dialogue unselected, requires human review, proposes duration and fences native placement and clearing", async t => {
  const h = await setup(); t.after(() => h.store.close());
  const id = newId("act"), request = action(h.production.meta.id, { operation: "performance", sceneId: h.scene.id, shotId: h.shot.id });
  await h.quotes().prepare(request, id, AT); await h.quotes().dispatch(request, id);
  const quote = await readPerformanceGenerationQuote(h.store, productionAudioOperationId(id));
  const bytes = wav(Array.from({ length: 48000 }, (_, i) => Math.round(Math.sin(i / 10) * 3000)));
  const jobId = newId("jb");
  const record = await finalizeGeneratedPerformance(h.store, undefined, quote, `pf_${id.slice(4)}`, bytes, "wav", { estimatedMicroUsd: quote.estimatedMicroUsd, actualMicroUsd: null }, jobId);
  assert.ok(record.kind === "generated-tts");
  assert.deepEqual(await finalizeGeneratedPerformance(h.store, undefined, quote, record.id, bytes, "wav", record.cost, jobId), record);
  const { voiceReference: _reference, ...input } = h.inputs[0]!;
  const job = JobSchema.parse({ ...input, id: jobId, status: "succeeded", createdAt: AT, updatedAt: AT, finalization: { status: "complete", error: null, updatedAt: AT } });
  assert.equal(generationCardResults(h.store, [job])[0]?.id, record.id);
  assert.deepEqual(generationCardResults(h.store, [{ ...job, id: newId("jb") }]), []);
  assert.deepEqual(generationCardResults(h.store, [{ ...job, finalization: { status: "pending", error: null, updatedAt: AT } }]), []);
  const current = () => h.store.getBundle().productions.find(p => p.meta.id === h.production.meta.id)!;
  assert.deepEqual(current().performanceReview.reviews, []); assert.deepEqual(current().performanceReview.selections, {});
  const timing = { postHandle: { kind: "reaction" as const, durationSec: 0.5 }, overflow: { mode: "forbid" as const } };
  const prepare = (command: Extract<ModelWorldChatAction, { kind: "production-performance-command" }>["command"]): Extract<WorldChatPreparedAction, { kind: "world-chat-production-performance-command" }> => {
    const action = { kind: "production-performance-command" as const, productionId: h.production.meta.id, command, checkReceiptIds: [newId("check")] };
    return { kind: "world-chat-production-performance-command", worldId: h.store.worldId, action, frozen: freezeProductionPerformance(h.store, action) };
  };
  await assert.rejects(productionPerformanceBody(h.store, prepare({ operation: "propose-duration", performanceId: record.id, leadInSec: 0.25, timing })), /Audition and accept/);
  await reviewPerformance(h.store, { kind: "review-performance", worldId: h.store.worldId, requestId: ulid(), productionId: h.production.meta.id, performanceId: record.id,
    decision: "accept", select: true, expectedSceneVersion: h.scene.version, expectedReviewHash: null, expectedSelectionHash: null });
  const card = () => ({ actionId: newId("act"), conversationId: newId("cv"), worldId: h.store.worldId, productionId: h.production.meta.id,
    actionKind: "world-chat-production-performance-command", status: "approved", authority: { kind: "timeline", id: newId("act") } }) as ConversationActionCard;
  const adapter = worldChatActionAdapters(h.store, null, () => AT).find(adapter => adapter.actionKind === "world-chat-production-performance-command")!;
  const duration = await executeProductionPerformance(h.store, prepare({ operation: "propose-duration", performanceId: record.id, leadInSec: 0.25, timing }), card());
  assert.equal(duration.receipt?.kind, "proposal"); assert.equal(current().scenes.find(s => s.id === h.scene.id)!.version, h.scene.version);
  await applyTimelineCommand(h.store, h.production.meta.id, { kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(current()),
    commands: [{ kind: "place", trackId: "tr_picture", clip: { id: "cl_dialogue_picture", startFrame: 0, durationFrames: 300, sourceInFrames: 0,
      source: { kind: "shot", shotId: h.shot.id, sceneNumber: h.scene.number, shotNumber: h.shot.number, label: h.shot.title } } }] });
  const prepared = prepare({ operation: "place-selected", performanceId: record.id, leadInSec: 0.25, timing });
  const placedCard = card();
  await executeProductionPerformance(h.store, prepared, placedCard);
  assert.equal((await adapter.reconcile!(placedCard))?.status, "completed", "the durable timeline history rejoins a committed placement after its preparation is gone");
  await assert.rejects(productionPerformanceBody(h.store, prepared), /changed/);
  assert.ok(current().timeline?.status === "ready");
  const before = structuredClone(current().timeline);
  const clearedCard = card();
  await executeProductionPerformance(h.store, prepare({ operation: "clear-selection", lineKey: performanceLineKey(record.target) }), clearedCard);
  assert.equal((await adapter.reconcile!(clearedCard))?.status, "completed", "the native selection commit rejoins after its preparation is gone");
  assert.equal(current().performanceReview.selections[performanceLineKey(record.target)]?.performanceId, null); assert.deepEqual(current().timeline, before, "clearing selection preserves already placed dialogue");
  assert.deepEqual(current().selections, h.production.selections);
});

it("prepares a sample only after approval, recovers its exact candidate without rerunning tools, and keeps rights human", async t => {
  const dir = await makeTempWorld(), artifactId = newId("ar");
  const bytes = wav(Array.from({ length: 48000 }, (_, i) => Math.round(Math.sin(i / 10) * 3000)));
  await mkdir(join(dir, "artifacts"), { recursive: true });
  await writeFile(join(dir, "artifacts/sample.wav"), bytes);
  await writeFile(join(dir, "artifacts/sample.wav.json"), JSON.stringify({ id: artifactId, kind: "audio", file: "sample.wav", hash: audioHash(bytes), origin: { by: "user" }, links: [], created: AT }));
  const store = await WorldStore.open(dir, { clock: () => AT }); t.after(() => store.close());
  let calls = 0;
  const tools = createAudioMediaTools({ async run(tool, args) {
    calls++; let stdout = "";
    if (tool === "ffprobe") stdout = JSON.stringify({ format: { duration: "1", format_name: "wav" }, streams: [{ codec_type: "audio", codec_name: "pcm_s16le", sample_fmt: "s16", sample_rate: "48000", channels: 1, bits_per_sample: 16 }] });
    else if (args[0] === "-version") stdout = "ffmpeg version test\n";
    else await writeFile(args.at(-1)!, bytes);
    return { code: 0, stdout: Buffer.from(stdout), stderr: "", timedOut: false, cancelled: false, outputLimitExceeded: false };
  } });
  const source = productionAudioGenerationSource(store, { manifest: SHIPPED_MANIFEST, settings: async () => null, providers: () => [], jobs: () => [],
    reader: async () => {}, narrator: async () => null, freeze: input => input, tools, confirmUploads: async () => {} });
  const quotes = () => new GenerationQuotes(store, source, { enqueue: async () => assert.fail("Local preparation must not enqueue a paid job"), jobs: () => [] });
  const id = newId("act"), request = action("saltlight", { operation: "prepare-voice-sample", sheetId: "maren-kest", source: { kind: "artifact", artifactId } });
  const before = structuredClone(store.getBundle().referenceKits.find(kit => kit.sheetId === "maren-kest"));
  await quotes().prepare(request, id, AT); assert.equal(calls, 0);
  const interrupted = join(dir, ".staging/audio", productionAudioOperationId(id));
  await mkdir(interrupted, { recursive: true });
  await writeFile(join(interrupted, "source.media"), bytes);
  await quotes().dispatch(request, id);
  const quarantined = (await readdir(join(dir, ".staging/audio-interrupted"))).find(name => name.startsWith(productionAudioOperationId(id)))!;
  assert.deepEqual(await readFile(join(dir, ".staging/audio-interrupted", quarantined, "source.media")), Buffer.from(bytes), "an incomplete local preparation is preserved before restarting");
  const count = calls;
  assert.ok(count > 0);
  const pending = await pendingCharacterSampleReviews(store);
  assert.equal(pending.reviews[0]!.operationId, productionAudioOperationId(id));
  await rm(join(dir, ".history/world/prepared", `${id}.audio-delivery.json`));
  const outcome = await quotes().reconcile({ actionId: id } as ConversationActionCard);
  assert.equal(outcome?.status, "completed"); assert.equal(outcome?.receipt?.id, pending.reviews[0]!.operationId);
  await quotes().dispatch(request, id); assert.equal(calls, count);
  assert.deepEqual(store.getBundle().referenceKits.find(kit => kit.sheetId === "maren-kest"), before);
  assert.deepEqual(await readFile(join(dir, "artifacts/sample.wav")), Buffer.from(bytes));
});
