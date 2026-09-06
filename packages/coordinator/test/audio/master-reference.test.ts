import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { basePictureTrack, masterAudioBinding, masterPerformanceShotIds, planCharacterAudio, characterAudioInstructions,
  FrozenMasterAudioSchema, newId, orderedShots, storyTimelineFingerprint, ulid } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { wav } from "./helpers.js";
import { audioHash } from "../../src/audio/qc.js";
import { createAudioMediaTools } from "../../src/audio/media-tools.js";
import { appendAudioRights } from "../../src/audio/rights.js";
import { prepareMasterAudioReference, resolveMasterAudioReferences, readCharacterAudioInputs } from "../../src/audio/reference-inputs.js";
import { applyTimelineCommand } from "../../src/productions/timeline.js";
import { SHIPPED_MANIFEST } from "../../../providers/src/manifest-data.js";
import { FalClient } from "../../../providers/src/clients/fal.js";

it("master playback freezes physical soundtrack time across picture trims and later re-anchoring", async t => {
  const dir = await makeTempWorld(), artifactId = newId("ar");
  const samples = Array.from({ length: 48000 * 20 }, (_, i) => Math.round(Math.sin(i / 11) * 3000));
  const original = wav(samples);
  await writeFile(join(dir, "artifacts/master.wav"), original);
  await writeFile(join(dir, "artifacts/master.wav.json"), JSON.stringify({ id: artifactId, kind: "audio", file: "master.wav",
    hash: audioHash(original), origin: { by: "user" }, links: [], created: "2026-09-05T12:00:00Z" }));
  const store = await WorldStore.open(dir); t.after(() => store.close());
  const initial = store.getBundle().productions[0]!;
  await applyTimelineCommand(store, initial.meta.id, { kind: "commands", commands: [], baseRevision: null, sourceFingerprint: storyTimelineFingerprint(initial) });
  const production = () => store.getBundle().productions.find(p => p.meta.id === initial.meta.id)!;
  const state = production().timeline;
  assert.equal(state?.status, "ready"); if (state?.status !== "ready") throw new Error("timeline missing");
  const existing = basePictureTrack(state.timeline)!.clips[0];
  const authoredScene = initial.scenes[0]!, authored = orderedShots(authoredScene)[0]!;
  const first = existing ?? { id: "cl_master_shot" as const, startFrame: 0, durationFrames: state.timeline.frameRate, sourceInFrames: 0,
    source: { kind: "shot" as const, shotId: authored.id, sceneNumber: authoredScene.number, shotNumber: authored.number, label: authored.title } };
  if (first.source.kind !== "shot") throw new Error("shot missing");
  const shotId = first.source.shotId, rate = state.timeline.frameRate;
  await applyTimelineCommand(store, initial.meta.id, { kind: "commands", baseRevision: state.timeline.revision, sourceFingerprint: storyTimelineFingerprint(production()), commands: [
    ...(existing ? [{ kind: "delete" as const, clipId: first.id }] : []),
    { kind: "place", trackId: basePictureTrack(state.timeline)!.id, clip: { ...first, durationFrames: rate, sourceInFrames: 9 * rate } },
    { kind: "add-track", trackId: "tr_soundtrack", trackKind: "audio", name: "Master soundtrack" },
    { kind: "place", trackId: "tr_soundtrack", clip: { id: "cl_soundtrack", startFrame: 0, durationFrames: 10 * rate,
      sourceInFrames: 2 * rate, source: { kind: "artifact", artifactId, label: "Master soundtrack" } } },
    { kind: "set-performance-source", clipId: first.id, sourceClipId: "cl_soundtrack" },
  ] });
  const binding = masterAudioBinding(production(), shotId);
  assert.deepEqual(binding.range, { inSec: 2, outSec: 3 }, "picture source-in does not shift the master slice");
  const tools = createAudioMediaTools({ async run(tool, args) {
    let stdout = "";
    if (tool === "ffprobe") stdout = JSON.stringify({ format: { duration: "20", format_name: "wav" }, streams: [{ codec_type: "audio",
      codec_name: "pcm_s16le", sample_fmt: "s16", sample_rate: "48000", channels: 1, bits_per_sample: 16 }] });
    else if (args[0] === "-version") stdout = "ffmpeg version test\n";
    else {
      const start = Math.round(Number(args[args.indexOf("-ss") + 1]) * 48000), count = Math.round(Number(args[args.indexOf("-t") + 1]) * 48000);
      await writeFile(args.at(-1)!, wav(samples.slice(start, start + count)));
    }
    return { code: 0, stdout: Buffer.from(stdout), stderr: "", timedOut: false, cancelled: false, outputLimitExceeded: false };
  } });
  const review = await prepareMasterAudioReference(store, tools, binding);
  const scene = production().scenes.find(s => orderedShots(s).some(shot => shot.id === shotId))!;
  const model = SHIPPED_MANIFEST.models.find(m => m.id === "seedance-2.0-fast")!;
  const input = { scene, shots: orderedShots(scene).filter(s => s.id === shotId), sheets: store.getBundle().sheets, kits: [], model, imageCount: 1,
    requiredMasterShots: masterPerformanceShotIds(production()) };
  assert.match(planCharacterAudio(input).problems.join(" "), /prepared master slice/);
  const masterReferences = await resolveMasterAudioReferences(store, initial.meta.id, scene.id, [{ operationId: review.operationId,
    hash: review.provenance.outputHash, binding, warningCodes: Object.values(review.provenance.qualityReport.checks).filter(c => c.outcome === "warning").map(c => c.code), cloudBasis: "licensed" }], ulid());
  assert.equal(FrozenMasterAudioSchema.safeParse({ ...masterReferences[0], intent: "voice-reference" }).success, false);
  const plan = planCharacterAudio({ ...input, masterReferences }); assert.deepEqual(plan.problems, []);
  const job = { model: model.id, provider: model.provider, params: { audioReferences: plan, references: ["frame.png"], durationSec: 5, prompt: characterAudioInstructions(plan) } };
  const bytes = await readCharacterAudioInputs(store, job, true);
  assert.deepEqual(Buffer.from(bytes[0]!.data), Buffer.from(wav(samples.slice(96000, 144000))));
  let payload: Record<string, unknown> | undefined;
  const fal = new FalClient(async (_url, init) => { payload = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ request_id: "master-mock" }), { status: 200 }); });
  await fal.submit("mock", { ...job, capability: "video", audioReferences: bytes, imageReferences: [{ name: "frame.png", contentType: "image/png", data: new Uint8Array([1]) }] });
  assert.equal(payload!.generate_audio, false); assert.equal(payload!.audioReferences, undefined);
  const current = production().timeline; if (current?.status !== "ready") throw new Error("timeline missing");
  await applyTimelineCommand(store, initial.meta.id, { kind: "commands", baseRevision: current.timeline.revision, sourceFingerprint: storyTimelineFingerprint(production()),
    commands: [{ kind: "move-to-frame", clipId: first.id, startFrame: 2 * rate }] });
  assert.deepEqual(masterAudioBinding(production(), shotId).range, { inSec: 4, outSec: 5 });
  await assert.rejects(readCharacterAudioInputs(store, job, true), /binding changed/);
  assert.deepEqual((await readCharacterAudioInputs(store, JSON.parse(JSON.stringify(job))))[0]!.data, bytes[0]!.data);
  await appendAudioRights(store, { schemaVersion: 1, action: "withdraw", acknowledgementId: masterReferences[0]!.acknowledgementId,
    audioHash: review.provenance.outputHash, at: store.now() });
  await assert.rejects(readCharacterAudioInputs(store, job), /audio-rights-required/);
  assert.deepEqual(await readFile(join(dir, "artifacts/master.wav")), Buffer.from(original));
});
