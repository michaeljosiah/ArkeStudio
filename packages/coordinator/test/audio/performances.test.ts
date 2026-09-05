import { resolvePerformanceAudioReferences, readCharacterAudioInputs, preparePerformanceAudioRange } from "../../src/audio/reference-inputs.js";
import { planCharacterAudio, characterAudioInstructions } from "@arke-studio/contracts";
import { FalClient } from "../../../providers/src/clients/fal.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import { placeSelectedPerformance, validatePlacedPerformanceBytes, proposePerformanceDuration } from "../../src/audio/performance-placement.js";
import { applyTimelineCommand } from "../../src/productions/timeline.js";
import { storyTimelineFingerprint, buildRenderPlan } from "@arke-studio/contracts";
import { writePerformanceBible } from "../../src/audio/performance-bible.js";
import { saveRehearsalNote } from "../../src/audio/rehearsal-notes.js";
import { planTableRead } from "../../src/audio/table-read.js";
import { SHIPPED_MANIFEST } from "../../../providers/src/manifest-data.js";
import assert from "node:assert/strict";
import { it } from "node:test";
import { writeFile, readFile, rename, lstat } from "node:fs/promises";
import { join } from "node:path";
import { orderedShots, resolvePerformanceLine, performanceLineKey, ulid } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { reviewPerformance } from "../../src/audio/performance-review.js";
import { purgePerformance } from "../../src/audio/performance-purge.js";
import { keepPerformanceRecording } from "../../src/audio/performances.js";
import { createAudioMediaTools } from "../../src/audio/media-tools.js";
import { makeTempWorld } from "../world/helpers.js";
import { wav } from "./helpers.js";

it("keeps one immutable scratch through retries and reopen without selecting picture or voice", async t => {
  const dir = await makeTempWorld();
  let store = await WorldStore.open(dir); t.after(() => store.close());
  const bundle = store.getBundle(), production = bundle.productions[0]!;
  const scene = production.scenes.find(scene => orderedShots(scene).some(s => resolvePerformanceLine(scene, s.id).ok))!;
  const shot = orderedShots(scene).find(s => resolvePerformanceLine(scene, s.id).ok)!;
  const originalSelections = structuredClone(production.selections), originalKits = structuredClone(bundle.referenceKits);
  const bytes = wav(Array.from({ length: 48000 }, (_, i) => Math.round(Math.sin(i / 10) * 3000)));
  const source = join(dir, "capture.webm"); await writeFile(source, bytes);
  let claims = 0;
  const spool = { async claim() { claims++; return { absolutePath: source, contentType: "audio/webm", sizeBytes: bytes.length }; }, async discard() {} };
  const tools = createAudioMediaTools({ async run(tool, args) {
    let stdout = "";
    if (tool === "ffprobe") stdout = JSON.stringify({ format: { duration: "1", format_name: "wav" }, streams: [{ codec_type: "audio",
      codec_name: "pcm_s16le", sample_fmt: "s16", sample_rate: "48000", channels: 1, bits_per_sample: 16 }] });
    else if (args[0] === "-version") stdout = "ffmpeg version test\n";
    else if (args.includes("-t")) {
      const start = Math.round(Number(args[args.indexOf("-ss") + 1]) * 48000);
      const length = Math.round(Number(args[args.indexOf("-t") + 1]) * 48000);
      await writeFile(args.at(-1)!, wav(Array.from({ length }, (_, i) => Buffer.from(bytes).readInt16LE(44 + (start + i) * 2))));
    } else await writeFile(args.at(-1)!, bytes);
    return { code: 0, stdout: Buffer.from(stdout), stderr: "", timedOut: false, cancelled: false, outputLimitExceeded: false };
  } });
  const request = { kind: "keep-performance-recording" as const, requestId: ulid(), worldId: store.worldId, productionId: production.meta.id,
    sceneId: scene.id, shotId: shot.id, expectedSceneVersion: scene.version, spoolId: "00000000-0000-4000-8000-000000000000", captureBasis: "self" as const };
  const record = await keepPerformanceRecording(store, tools, spool, request);
  assert.equal(record.kind, "scratch"); assert.equal(record.transcript?.status, "unavailable");
  assert.deepEqual(await keepPerformanceRecording(store, tools, spool, request), record);
  assert.equal(claims, 1);
  await store.close(); store = await WorldStore.open(dir);
  const current = store.getBundle().productions.find(p => p.meta.id === production.meta.id)!;
  assert.deepEqual(current.performances, [record]);
  assert.deepEqual(current.selections, originalSelections);
  assert.deepEqual(store.getBundle().referenceKits, originalKits);
  assert.deepEqual(await readFile(join(dir, `productions/${production.meta.id}/performances/${record.id}/${record.file}`)), Buffer.from(bytes));
  await assert.rejects(keepPerformanceRecording(store, tools, spool, { ...request, requestId: ulid(), expectedSceneVersion: scene.version + 1 }), /scene changed/);
  assert.equal(claims, 1);
  await assert.rejects(purgePerformance(store, production.meta.id, record.id, [{ worldId: store.worldId, params: { sourcePerformanceId: record.id } }] as never), /referenced/);
  const performanceDir = join(dir, `productions/${production.meta.id}/performances/${record.id}`);
  await store.ownedWrite(() => rename(performanceDir, join(dir, `.staging/performance-purge/${record.id}`)));
  await store.close(); store = await WorldStore.open(dir);
  assert.equal(store.getBundle().productions.find(p => p.meta.id === production.meta.id)!.performances.length, 1, "an unjournalled purge restores its manifest and bytes");
  await purgePerformance(store, production.meta.id, record.id, []);
  assert.equal(await lstat(performanceDir).catch(() => null), null);
  await store.close(); store = await WorldStore.open(dir);
  assert.equal(store.getBundle().productions.find(p => p.meta.id === production.meta.id)!.performances.length, 0);
  await assert.rejects(keepPerformanceRecording(store, tools, spool, request), /purged/);
  assert.equal(claims, 1, "a tombstone prevents stale Keep from claiming again");
  const next = await keepPerformanceRecording(store, tools, spool, { ...request, requestId: ulid() });
  const review = { kind: "review-performance" as const, requestId: ulid(), worldId: store.worldId, productionId: production.meta.id,
    performanceId: next.id, decision: "accept" as const, expectedReviewHash: null, expectedSelectionHash: null };
  await reviewPerformance(store, review);
  await reviewPerformance(store, review);
  const reviewed = store.getBundle().productions.find(p => p.meta.id === production.meta.id)!;
  assert.equal(reviewed.performanceReview.reviews.length, 1, "retry does not duplicate review");
  assert.equal(reviewed.performanceReview.selections[performanceLineKey(next.target)]?.performanceId, next.id);
  assert.deepEqual(reviewed.selections, originalSelections, "performance acceptance never changes picture selection");
  await assert.rejects(reviewPerformance(store, { ...review, requestId: ulid() }), /review changed/);
  const durationRequest = { kind:"propose-performance-duration" as const,requestId:ulid(),worldId:store.worldId,productionId:production.meta.id,
    performanceId:next.id,expectedSceneVersion:scene.version,leadInSec:0.25,timing:{postHandle:{kind:"reaction" as const,durationSec:0.5},overflow:{mode:"forbid" as const}} };
  const durationProposal=await proposePerformanceDuration(store,durationRequest);
  assert.equal(store.getBundle().productions.find(p=>p.meta.id===production.meta.id)!.scenes.find(s=>s.id===scene.id)!.version,scene.version,"timing stays proposed until accepted");
  assert.equal(durationProposal.kind,"scene-edit");
  await assert.rejects(proposePerformanceDuration(store,{...durationRequest,expectedSceneVersion:scene.version+1}),/line changed/);
  await new ProposalManager(store).discard(durationProposal.id);
  await applyTimelineCommand(store, production.meta.id, { kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(reviewed),
    commands: [{ kind: "place", trackId: "tr_picture", clip: { id: "cl_dialogue_picture", startFrame: 0, durationFrames: 300, sourceInFrames: 0,
      source: { kind: "shot", shotId: shot.id, sceneNumber: scene.number, shotNumber: shot.number, label: shot.title } } }] });
  const withTimeline = store.getBundle().productions.find(p => p.meta.id === production.meta.id)!;
  assert.equal(withTimeline.timeline?.status, "ready");
  if (withTimeline.timeline?.status !== "ready") throw new Error("timeline missing");
  const referenceRequest = { performanceId: next.id, hash: next.provenance.outputHash,
    acceptedReviewAt: withTimeline.performanceReview.reviews.filter(r => r.performanceId === next.id).at(-1)!.ts,
    intent: "performance-sync" as const, warningCodes: Object.values(next.provenance.qualityReport.checks).filter(c => c.outcome === "warning").map(c => c.code),
    singleSpeaker: true as const, noMusic: true as const, cloudBasis: "self" as const };
  await assert.rejects(resolvePerformanceAudioReferences(store, production.meta.id, scene.id,
    [{ ...referenceRequest, hash: `sha256:${"a".repeat(64)}` }], ulid()), /changed/);
  const performanceReferences = await resolvePerformanceAudioReferences(store, production.meta.id, scene.id, [referenceRequest], ulid());
  const videoModel = SHIPPED_MANIFEST.models.find(m => m.id === "seedance-2.0-fast")!;
  const audioPlan = planCharacterAudio({ scene, shots: [shot], sheets: store.getBundle().sheets, kits: [], model: videoModel,
    imageCount: 1, performanceReferences });
  assert.deepEqual(audioPlan.problems, []);
  const audioJob = { model: videoModel.id, provider: videoModel.provider, params: { audioReferences: audioPlan,
    references: ["character.png"], prompt: characterAudioInstructions(audioPlan), durationSec: 5 } };
  const prepared = await readCharacterAudioInputs(store, audioJob);
  let submitted: Record<string, unknown> | undefined;
  const fal = new FalClient(async (_url, init) => { submitted = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ request_id: "performance-mock" }), { status: 200 }); });
  await fal.submit("mock", { ...audioJob, capability: "video", audioReferences: prepared,
    imageReferences: [{ name: "character.png", contentType: "image/png", data: new Uint8Array([1]) }] });
  assert.equal(submitted!.generate_audio, false);
  assert.deepEqual(submitted!.audio_urls, [`data:audio/wav;base64,${Buffer.from(bytes).toString("base64")}`]);
  assert.equal(submitted!.audioReferences, undefined);
  assert.match(String(submitted!.prompt), /final soundtrack/);
  const mixed = { ...audioJob, params: { ...audioJob.params, audioReferences: { ...audioPlan,
    references: [audioPlan.references[0]!, { ...audioPlan.references[0]!, intent: "voice-reference", label: "@Audio2" }] } } };
  await assert.rejects(readCharacterAudioInputs(store, mixed), /Mixed audio intents/);
  const trimmed = await preparePerformanceAudioRange(store, tools, { kind: "prepare-performance-audio-reference", worldId: store.worldId,
    requestId: ulid(), productionId: production.meta.id, performanceId: next.id, expectedHash: next.provenance.outputHash,
    range: { inSec: 0.125, outSec: 0.875 } });
  assert.equal(trimmed.provenance.outputTechnical.durationSec, 0.75);
  const rangeRequest = { ...referenceRequest, prepared: { operationId: trimmed.operationId, hash: trimmed.provenance.outputHash },
    warningCodes: Object.values(trimmed.provenance.qualityReport.checks).filter(c => c.outcome === "warning").map(c => c.code) };
  const rangeRequestId = ulid();
  const rangeReferences = await resolvePerformanceAudioReferences(store, production.meta.id, scene.id, [rangeRequest], rangeRequestId);
  assert.deepEqual(await resolvePerformanceAudioReferences(store, production.meta.id, scene.id, [rangeRequest], rangeRequestId), rangeReferences, "lost response reuses the committed preparation receipt");
  const rangePlan = planCharacterAudio({ scene, shots: [shot], sheets: store.getBundle().sheets, kits: [], model: videoModel,
    imageCount: 1, performanceReferences: rangeReferences });
  const rangeBytes = await readCharacterAudioInputs(store, { ...audioJob, params: { ...audioJob.params, audioReferences: rangePlan } }, true);
  assert.equal(rangeBytes[0]!.data.length, 44 + 36000 * 2);
  assert.deepEqual(await readFile(join(dir, `productions/${production.meta.id}/performances/${next.id}/${next.file}`)), Buffer.from(bytes), "trimming never modifies the original performance");
  const placement = { kind: "place-selected-performance" as const, requestId: ulid(), worldId: store.worldId,
    productionId: production.meta.id, performanceId: next.id, expectedTimelineRevision: withTimeline.timeline.timeline.revision,
    expectedTimelineHash: withTimeline.timeline.hash!, expectedSelectionHash: withTimeline.performanceReview.selectionHash,
    leadInSec: 0.125, timing: { sourceRange: { inSec: 0.125, outSec: 0.875 }, postHandle: { kind: "reaction" as const, durationSec: 0.25 }, overflow: { mode: "forbid" as const } } };
  await placeSelectedPerformance(store, placement);
  await assert.rejects(placeSelectedPerformance(store, { ...placement, requestId: ulid(), leadInSec: 0.2 }), /cut changed/);
  const placed = store.getBundle().productions.find(p => p.meta.id === production.meta.id)!;
  assert.deepEqual(placed.selections, originalSelections, "dialogue placement never selects picture");
  await validatePlacedPerformanceBytes(store, placed);
  const rendered = buildRenderPlan({ production: placed, timeline: placed.timeline, artifacts: store.getBundle().artifacts, scope: { kind: "production" }, preset: "review-cut" });
  assert.ok(rendered.ok, rendered.ok ? "" : rendered.reason);
  const dialogue = rendered.plan.audio.find(a => a.role === "dialogue")!;
  assert.equal(dialogue.startSec, 0.125); assert.equal(dialogue.endSec, 0.875); assert.equal(dialogue.sourceInSec, 0.125);
  const planned = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [], []);
  assert.equal(planned.plan.items.find(i => i.lineId === performanceLineKey(next.target))?.route, "existing");
  assert.equal(planned.cloud.length, 0, "accepted playback never enqueues a synthesis");
  const noteRequest = { kind: "save-rehearsal-note" as const, requestId: ulid(), worldId: store.worldId, productionId: production.meta.id,
    sceneId: scene.id, rehearsalId: `rh_${ulid()}`, expectedHash: null, lineId: performanceLineKey(next.target), body: "Leave a beat before answering." };
  await saveRehearsalNote(store, noteRequest);
  const noted = store.getBundle().productions.find(p => p.meta.id === production.meta.id)!;
  assert.equal(noted.rehearsals[0]!.notes[noteRequest.lineId]!.body, noteRequest.body);
  assert.equal(noted.scenes.find(s => s.id === scene.id)!.version, scene.version);
  await assert.rejects(saveRehearsalNote(store, { ...noteRequest, requestId: ulid(), body: "Different note" }), /notes changed/);
  const designation = { kind: "designate-performance-bible" as const, requestId: ulid(), worldId: store.worldId, sheetId: next.target.speakerSheetId,
    slotId: "measured-example", expectedHash: null, expectedRevision: 0, label: "Measured example", delivery: "measured" as const,
    role: "cadence" as const, productionId: production.meta.id, performanceId: next.id, expectedPerformanceHash: next.provenance.outputHash,
    acceptedReviewAt: reviewed.performanceReview.reviews[0]!.ts, cloudBasis: "self" as const, singleSpeaker: true, noMusic: true,
    warningCodes: Object.values(next.provenance.qualityReport.checks).filter(c => c.outcome === "warning").map(c => c.code) };
  await writePerformanceBible(store, designation);
  await writePerformanceBible(store, designation);
  const bible = store.getBundle().performanceBibles!.find(b => b.sheetId === next.target.speakerSheetId)!;
  assert.equal(bible.events.length, 1, "designation replay does not append duplicate history");
  await assert.rejects(writePerformanceBible(store, { ...designation, requestId: ulid(), slotId: "identity-example", role: "identity", expectedHash: bible.hash }), /cadence only/);
  await writePerformanceBible(store, { kind: "clear-performance-bible", requestId: ulid(), worldId: store.worldId, sheetId: next.target.speakerSheetId,
    slotId: "measured-example", expectedHash: bible.hash, expectedRevision: 1 });
  assert.equal(store.getBundle().performanceBibles!.find(b => b.sheetId === next.target.speakerSheetId)!.events.length, 2);

  await reviewPerformance(store, { ...review, requestId: ulid(), decision: "reject", expectedReviewHash: reviewed.performanceReview.reviewHash,
    expectedSelectionHash: reviewed.performanceReview.selectionHash });
  const rejected = store.getBundle().productions.find(p => p.meta.id === production.meta.id)!;
  assert.equal(rejected.performanceReview.reviews.length, 2);
  await assert.rejects(readCharacterAudioInputs(store, audioJob, true), /accepted performance changed/);
  assert.deepEqual(Buffer.from((await readCharacterAudioInputs(store, JSON.parse(JSON.stringify(audioJob))))[0]!.data), Buffer.from(bytes), "queued reference remains frozen after a later review");
  assert.equal(rejected.performanceReview.selections[performanceLineKey(next.target)]?.performanceId, next.id, "rejection leaves current selection unchanged");
  await assert.rejects(purgePerformance(store, production.meta.id, next.id, []), /referenced/);
  await store.close(); store = await WorldStore.open(dir);
  assert.deepEqual(store.getBundle().productions.find(p => p.meta.id === production.meta.id)!.performanceReview, rejected.performanceReview);

});
