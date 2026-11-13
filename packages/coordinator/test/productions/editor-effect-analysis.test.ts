import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MIX, defaultEffectClip, buildRenderPlan, resolveEffectAudioSource, type ProductionTimeline } from "@arke-studio/contracts";
import { EditorEffectAnalysisService } from "../../src/productions/editor-effect-analysis.js";
import { EditorEffectDependencies } from "../../src/productions/editor-effect-dependencies.js";
import { sha256 } from "../../src/world/text-files.js";
import { readEffectManifest } from "../../src/productions/editor-effect-analysis-cache.js";
import { applyHumanTimelineCommand } from "../../src/productions/timeline.js";
import { createNodeEffectAudioAnalysisHost } from "../../src/media/node-effect-audio.js";
import { createNodeMediaProcessRunner } from "../../src/media/node-media-process.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const PRODUCTION = "saltlight", AUDIO = "ar_01J8G0000000000000000000R1";
const ffmpeg = process.env["ARKE_FFMPEG"] ?? "ffmpeg";
const media = createNodeMediaProcessRunner({ ffmpeg, ffprobe: "ffprobe" });
const probe = await media.run("ffmpeg", ["-version"], { signal: new AbortController().signal, timeoutMs: 10000, maxStdoutBytes: 65536, maxStderrBytes: 16384 });
const available = probe.code === 0;
if (process.env["ARKE_EFFECT_NATIVE_REQUIRED"] === "1") assert.ok(available);
const native = createNodeEffectAudioAnalysisHost({ ffmpeg });
const production = (store: WorldStore) => store.getBundle().productions.find(value => value.meta.id === PRODUCTION)!;
const timeline = (store: WorldStore) => { const state = production(store).timeline; assert.equal(state?.status, "ready"); return (state as { status: "ready"; timeline: ProductionTimeline }).timeline; };
function wave() {
  const frames = 48000, buffer = Buffer.alloc(44 + frames * 4);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVEfmt ", 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(2, 22); buffer.writeUInt32LE(48000, 24); buffer.writeUInt32LE(192000, 28);
  buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36); buffer.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) { const value = Math.round(Math.sin(i * 2 * Math.PI * 80 / 48000) * 12000); buffer.writeInt16LE(value, 44 + i * 4); buffer.writeInt16LE(-value, 46 + i * 4); }
  return buffer;
}
async function world() {
  const dir = await makeTempWorld();
  const effect = defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", seed: 42, startFrame: 0, durationFrames: 48 });
  effect.audioInput = { kind: "audio-clip", clipId: "cl_song" }; effect.reaction.enabled = true;
  const record: ProductionTimeline = { schemaVersion: 1, revision: 0, frameRate: 24, mix: DEFAULT_MIX, library: [], history: { undo: [], redo: [] }, migratedCut: true,
    tracks: [{ id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, endFrame: 48, clips: [] },
      { id: "tr_sound", kind: "audio", name: "Sound", order: 1, muted: false, clips: [{ id: "cl_song", startFrame: 12, durationFrames: 24, sourceInFrames: 0,
        source: { kind: "artifact", artifactId: AUDIO, label: "Sound" } }] },
      { id: "tr_fx", kind: "effect", name: "Effects", order: 2, muted: false, clips: [], effects: [effect] }] };
  await writeFile(join(dir, `productions/${PRODUCTION}/timeline.json`), JSON.stringify(record));
  await writeFile(join(dir, "artifacts/harbour-bells.wav"), wave());
  const sidecarPath = join(dir, "artifacts/harbour-bells.wav.json"), sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
  sidecar.mediaInfo = { hasAudio: true, hasVideo: false, durationSec: 1, audioChannels: 2, audioSampleRateHz: 48000 };
  await writeFile(sidecarPath, JSON.stringify(sidecar));
  const store = await WorldStore.open(dir); closeOnCleanup(() => store.close()); return store;
}
const service = () => { const value = new EditorEffectAnalysisService(native, () => {}); closeOnCleanup(() => value.stop()); return value; };
const row = (analysis: EditorEffectAnalysisService, store: WorldStore) => analysis.project(store)[0]!.byEffectId["cl_dust"]!;

test("candidate reaction freezes independently and Apply validation never prepares audio or writes Current", { skip: !available }, async () => {
  const store = await world(); let rendered = 0;
  const analysis = new EditorEffectAnalysisService({ ...native, renderAudiblePcm: async request => { rendered++; return native.renderAudiblePcm(request); } }, () => {});
  closeOnCleanup(() => analysis.stop());
  const dependencies = new EditorEffectDependencies(analysis), current = timeline(store), candidate = structuredClone(current);
  candidate.tracks[2]!.effects![0]!.audioInput = { kind: "composition-mix" };
  const path = join(store.dir, `productions/${PRODUCTION}/timeline.json`), raw = await readFile(path, "utf8");
  const fence = await dependencies.captureDependencies({ store, productionId: PRODUCTION, baseTimelineHash: sha256(raw), candidate,
    candidateBasisHash: sha256("candidate-composition") });
  assert.equal(fence.issues.length, 0); assert.equal(fence.reactions[0]!.status, "ready");
  assert.equal(row(analysis, store).status, "source-changed", "pending analysis never installs Current readiness");
  assert.equal(await readFile(path, "utf8"), raw); assert.equal(timeline(store), current);
  const prepared = rendered;
  await dependencies.validateDependencies({ store, productionId: PRODUCTION, current, candidate, candidateHash: sha256("frozen"), expectedFence: fence, phase: "gate" });
  assert.equal(rendered, prepared, "Apply checks source/decoder identities but never produces new features");
  await writeFile(join(store.dir, "artifacts/harbour-bells.wav"), "source replaced after Review");
  await assert.rejects(dependencies.validateDependencies({ store, productionId: PRODUCTION, current, candidate,
    candidateHash: sha256("frozen"), expectedFence: fence, phase: "precommit" }), /Media changed|Audio source changed/);
  assert.equal(rendered, prepared); assert.equal(await readFile(path, "utf8"), raw);
});

test("unavailable candidate analysis remains a named frozen fence and never becomes applicable", async () => {
  const store = await world(), analysis = new EditorEffectAnalysisService(undefined, () => {});
  closeOnCleanup(() => analysis.stop());
  const dependencies = new EditorEffectDependencies(analysis), current = timeline(store), raw = await readFile(join(store.dir, `productions/${PRODUCTION}/timeline.json`), "utf8");
  const fence = await dependencies.captureDependencies({ store, productionId: PRODUCTION, baseTimelineHash: sha256(raw),
    candidate: current, candidateBasisHash: sha256("unavailable") });
  assert.equal(fence.reactions[0]!.status, "unavailable");
  await dependencies.validateDependencies({ store, productionId: PRODUCTION, current, candidate: current,
    candidateHash: sha256("frozen"), expectedFence: fence, phase: "gate", requireReady: false });
  await assert.rejects(dependencies.validateDependencies({ store, productionId: PRODUCTION, current, candidate: current,
    candidateHash: sha256("frozen"), expectedFence: fence, phase: "gate" }), /not ready/);
  assert.equal(timeline(store).revision, 0); assert.equal(timeline(store).history.undo.length, 0);
});

test("precommit re-reads resolution metadata while external watcher work is queued behind the gate", async () => {
  const store = await world(), analysis = new EditorEffectAnalysisService(undefined, () => {});
  closeOnCleanup(() => analysis.stop());
  const dependencies = new EditorEffectDependencies(analysis), current = timeline(store), candidate = structuredClone(current);
  candidate.tracks[2]!.effects![0]!.reaction.enabled = false;
  const timelineFile = join(store.dir, `productions/${PRODUCTION}/timeline.json`), raw = await readFile(timelineFile, "utf8");
  const fence = await dependencies.captureDependencies({ store, productionId: PRODUCTION, baseTimelineHash: sha256(raw),
    candidate, candidateBasisHash: "a".repeat(64) });
  const input = { store, productionId: PRODUCTION, current, candidate, candidateHash: "b".repeat(64), expectedFence: fence };
  await store.gateOp(async () => {
    await dependencies.validateDependencies({ ...input, phase: "gate" });
    const file = join(store.dir, `productions/${PRODUCTION}/production.json`), before = await readFile(file, "utf8");
    try {
      const metadata = JSON.parse(before); metadata.aspect = metadata.aspect === "9:16" ? "16:9" : "9:16";
      await writeFile(file, JSON.stringify(metadata));
      await assert.rejects(dependencies.validateDependencies({ ...input, phase: "precommit" }), /resolution changed/);
      assert.equal(await readFile(timelineFile, "utf8"), raw);
    } finally { await writeFile(file, before); }
  });
});

test("real analysis caches exact audible features without a revision, rescan or Undo; appearance changes reuse them", { skip: !available }, async () => {
  const store = await world(), analysis = service(), before = timeline(store), path = join(store.dir, `productions/${PRODUCTION}/timeline.json`);
  const bytes = await readFile(path, "utf8"), events = await readFile(join(store.dir, "changes.jsonl"), "utf8");
  assert.equal(row(analysis, store).status, "source-changed", JSON.stringify(row(analysis, store)));
  await analysis.request(store, PRODUCTION, "cl_dust", "prepare");
  const ready = row(analysis, store); assert.equal(ready.status, "ready", JSON.stringify(ready)); if (ready.status !== "ready") return;
  assert.equal(timeline(store), before); assert.equal(await readFile(path, "utf8"), bytes); assert.equal(await readFile(join(store.dir, "changes.jsonl"), "utf8"), events);
  const manifest = await readEffectManifest(store, ready.manifestKey); assert.ok(manifest); assert.equal(manifest.features.energy.length, 48);
  assert.ok(manifest.features.energy.slice(0, 12).every(value => value === 0)); assert.ok(manifest.features.energy[20]! > 0);
  assert.equal((await analysis.readyForExport(store, PRODUCTION)).get("cl_dust")!.manifestKey, ready.manifestKey);
  assert.ok(await analysis.serve(store, store.getBundle().meta.slug, `.cache/editor-effects/analysis/${ready.manifestKey}.json`));
  assert.equal(await analysis.serve(store, "another-world", `.cache/editor-effects/analysis/${ready.manifestKey}.json`), null);
  assert.equal(await analysis.serve(store, store.getBundle().meta.slug, "productions/saltlight/timeline.json"), null);
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: 0, sourceFingerprint: "", commands: [{ kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { amount: .7 } } }] });
  const unchanged = row(analysis, store); assert.equal(unchanged.status, "ready"); if (unchanged.status === "ready") assert.equal(unchanged.manifestKey, ready.manifestKey);
  await analysis.request(store, PRODUCTION, "cl_dust", "prepare");
  const cached = row(analysis, store); assert.equal(cached.status, "ready"); if (cached.status === "ready") assert.equal(cached.manifestKey, ready.manifestKey);
});

test("mute invalidates reaction and yields ready silence, with the selected file still hashed", { skip: !available }, async () => {
  const store = await world(), analysis = service(); await analysis.request(store, PRODUCTION, "cl_dust", "prepare");
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: 0, sourceFingerprint: "", commands: [{ kind: "set-track", trackId: "tr_sound", muted: true }] });
  assert.equal(row(analysis, store).status, "source-changed"); await analysis.request(store, PRODUCTION, "cl_dust", "prepare");
  const ready = row(analysis, store); assert.equal(ready.status, "ready", JSON.stringify(ready)); if (ready.status !== "ready") return;
  assert.equal(ready.silent, true);
  const manifest = await readEffectManifest(store, ready.manifestKey); assert.equal(manifest!.descriptor.sources.length, 1); assert.equal(manifest!.descriptor.contributions.length, 0);
  await writeFile(join(store.dir, "artifacts/harbour-bells.wav"), "changed");
  await assert.rejects(analysis.readyForExport(store, PRODUCTION), /source changed/);
});

test("cancel is explicit, Off does no work, and read-only preparation cannot write", { skip: !available }, async () => {
  const store = await world(), analysis = service();
  const pending = analysis.request(store, PRODUCTION, "cl_dust", "prepare"); await analysis.request(store, PRODUCTION, "cl_dust", "cancel"); await pending;
  assert.equal(row(analysis, store).status, "failed"); await analysis.request(store, PRODUCTION, "cl_dust", "prepare"); assert.equal(row(analysis, store).status, "failed");
  await analysis.request(store, PRODUCTION, "cl_dust", "retry"); assert.equal(row(analysis, store).status, "ready");
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: 0, sourceFingerprint: "", commands: [{ kind: "effect-patch", clipId: "cl_dust", patch: { reaction: { enabled: false } } }] });
  assert.equal(row(analysis, store).status, "off"); await analysis.request(store, PRODUCTION, "cl_dust", "prepare"); assert.equal(row(analysis, store).status, "off");
  await store.close();
  const reopened = await WorldStore.open(store.dir, { readOnly: true }); closeOnCleanup(() => reopened.close());
  assert.equal(analysis.project(reopened)[0]!.canPrepare, false);
  await assert.rejects(reopened.derivedWrite(async () => {}), /read-only/);
});

test("source resolution separates stills, empty sound tracks, muted windows and exhausted physical sources", async () => {
  const store = await world(), original = production(store), record = timeline(store);
  const plan = buildRenderPlan({ production: original, artifacts: store.getBundle().artifacts, timeline: original.timeline, scope: { kind: "production" }, preset: "review-cut" }); assert.ok(plan.ok);
  const resolve = (input: Parameters<typeof resolveEffectAudioSource>[0]["input"], candidate = record) => resolveEffectAudioSource({ timeline: candidate, production: original, artifacts: store.getBundle().artifacts, plan: plan.plan, input });
  assert.equal(resolve({ kind: "audio-track", trackId: "tr_picture" }).ok, false);
  const empty = structuredClone(record); empty.tracks[1]!.clips = [];
  const emptySound = resolve({ kind: "audio-track", trackId: "tr_sound" }, empty); assert.ok(emptySound.ok); assert.equal(emptySound.currentlySilent, true);
  const source = resolve({ kind: "audio-clip", clipId: "cl_song" }); assert.ok(source.ok); assert.deepEqual(source.placedWindows, [{ startSec: .5, endSec: 1.5 }]);
  const exhausted = structuredClone(record); exhausted.tracks[1]!.clips[0]!.sourceInFrames = 48;
  const past = resolve({ kind: "audio-clip", clipId: "cl_song" }, exhausted); assert.ok(past.ok); assert.equal(past.currentlySilent, true); assert.deepEqual(past.audibleWindows, []);
});

test("a replacement prepare waits for the cancelled old source job and prepares the new binding state", { skip: !available }, async () => {
  const store = await world();
  let entered!: () => void, release!: () => void;
  const observed = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const analysis = new EditorEffectAnalysisService({ ...native, describe: async request => {
    if (first) { first = false; entered(); await barrier; }
    return native.describe(request);
  } }, () => {});
  closeOnCleanup(() => analysis.stop());
  const old = analysis.request(store, PRODUCTION, "cl_dust", "prepare"); await observed;
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: 0, sourceFingerprint: "", commands: [{ kind: "set-track", trackId: "tr_sound", muted: true }] });
  assert.equal(row(analysis, store).status, "source-changed");
  const changed = analysis.request(store, PRODUCTION, "cl_dust", "prepare"); release(); await Promise.all([old, changed]);
  const ready = row(analysis, store); assert.equal(ready.status, "ready", JSON.stringify(ready)); if (ready.status === "ready") assert.equal(ready.silent, true);
  assert.equal(timeline(store).revision, 1); assert.equal(timeline(store).history.undo.length, 1);
});

test("export requires analysis only for delivered effects and fences the snapshot revision", async () => {
  const store = await world(), analysis = service();
  const value = production(store), planned = buildRenderPlan({ production: value, artifacts: store.getBundle().artifacts, timeline: value.timeline, scope: { kind: "production" }, preset: "review-cut" }); assert.ok(planned.ok);
  const outside = { ...planned.plan.effectRender!, startFrame: 48, endFrame: 72 };
  assert.equal((await analysis.readyForExport(store, PRODUCTION, outside, 0)).size, 0);
  const muted = { ...planned.plan.effectRender!, effectLayers: [] };
  assert.equal((await analysis.readyForExport(store, PRODUCTION, muted, 0)).size, 0);
  await assert.rejects(analysis.readyForExport(store, PRODUCTION, planned.plan.effectRender, 0), /not ready/);
  await assert.rejects(analysis.readyForExport(store, PRODUCTION, outside, 1), /Timeline changed/);
});
