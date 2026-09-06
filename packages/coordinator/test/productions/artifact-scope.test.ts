import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildRenderPlan, spineTimelineFingerprint, storyTimelineFingerprint, type ProductionBundle } from "@arke-studio/contracts";
import { fileArtifact, setOwner } from "../../src/artifacts/filing.js";
import { applyTimelineCommand } from "../../src/productions/timeline.js";
import { importEditorMedia } from "../../src/productions/editor-import.js";
import { placeOverlay, removeOverlay, saveAudioTracks, splitOverlayAudio } from "../../src/takes/review.js";
import { stageEditorRequests } from "../../src/productions/editor-requests.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

const PRODUCTION = "saltlight";
const probe = { async durationSec() { return 3; }, async info() { return { durationSec: 3, hasAudio: true }; } };
const productionOf = (store: WorldStore): ProductionBundle => store.getBundle().productions.find(p => p.meta.id === PRODUCTION)!;
const timelinePath = (store: WorldStore) => join(store.dir, "productions", PRODUCTION, "timeline.json");

it("refuses direct, Library and legacy placements of another production's artifact without writing (#895)", async t => {
  const store = await WorldStore.open(await makeTempWorld()); t.after(() => store.close());
  const artifact = store.getBundle().artifacts.find(a => a.kind === "audio")!;
  await setOwner(store, artifact, "another-production");
  const p = productionOf(store), sourceFingerprint = storyTimelineFingerprint(p);
  const before = await readFile(timelinePath(store), "utf8").catch(() => null);
  await assert.rejects(applyTimelineCommand(store, PRODUCTION, {
    kind: "commands", baseRevision: null, sourceFingerprint,
    commands: [{ kind: "add-track", trackId: "tr_sound", trackKind: "audio", name: "Sound" },
      { kind: "place", trackId: "tr_sound", clip: { id: "cl_foreign", startFrame: 0, durationFrames: 24, sourceInFrames: 0,
        source: { kind: "artifact", artifactId: artifact.id, label: "Foreign sound" } } }],
  }), /cl_foreign cites artifact .*belongs to another production.*Import the file/);
  await assert.rejects(applyTimelineCommand(store, PRODUCTION, {
    kind: "commands", baseRevision: null, sourceFingerprint,
    commands: [{ kind: "add-to-library", items: [{ kind: "artifact", artifactId: artifact.id }] }],
  }), /library cannot hold artifact .*belongs to another production/);
  assert.equal(await readFile(timelinePath(store), "utf8").catch(() => null), before);
  const cutPath = join(store.dir, "productions", PRODUCTION, "cut.json");
  const beforeCut = await readFile(cutPath, "utf8").catch(() => null);
  await assert.rejects(placeOverlay(store, PRODUCTION, { artifactId: artifact.id, startSec: 0, endSec: 1 }), /belongs to another production/);
  assert.equal(await readFile(cutPath, "utf8").catch(() => null), beforeCut);
  await assert.rejects(placeOverlay(store, PRODUCTION, { artifactId: "ar_01J8G0000000000000000000ZZ", startSec: 0, endSec: 1 }), /which this world does not have/);
});

it("keeps an existing scoped clip removable but refuses detachment and delivery (#895)", async t => {
  const store = await WorldStore.open(await makeTempWorld()); t.after(() => store.close());
  const source = join(store.dir, "scope-video.mp4"); await writeFile(source, "scope fixture");
  const filed = await fileArtifact(store, { sourcePath: source, mediaProbe: probe, production: PRODUCTION });
  assert.ok(filed.outcome === "filed");
  await applyTimelineCommand(store, PRODUCTION, {
    kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(productionOf(store)),
    commands: [{ kind: "place", trackId: "tr_picture", clip: { id: "cl_video", startFrame: 0, durationFrames: 48, sourceInFrames: 0,
      source: { kind: "artifact", artifactId: filed.artifact.id, label: "scope-video.mp4" } } }],
  });
  await setOwner(store, filed.artifact, "another-production");
  const p = productionOf(store); assert.ok(p.timeline?.status === "ready");
  const plan = buildRenderPlan({ production: p, timeline: p.timeline, artifacts: store.getBundle().artifacts, scope: { kind: "production" }, preset: "review-cut" });
  assert.ok(!plan.ok); assert.match(plan.reason, /belongs to another production/);
  const before = await readFile(timelinePath(store), "utf8");
  await assert.rejects(applyTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: p.timeline.timeline.revision, sourceFingerprint: storyTimelineFingerprint(p),
    commands: [{ kind: "detach-audio", clipId: "cl_video", newClipId: "cl_sound" }],
  }), /belongs to another production/);
  assert.equal(await readFile(timelinePath(store), "utf8"), before);
  for (const command of [{ kind: "duplicate" as const, clipId: "cl_video" as const, newClipId: "cl_copy" as const },
    { kind: "split" as const, clipId: "cl_video" as const, newClipId: "cl_second" as const, atFrame: 24 }]) {
    await assert.rejects(applyTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: p.timeline.timeline.revision,
      sourceFingerprint: storyTimelineFingerprint(p), commands: [command],
    }), /belongs to another production/);
    assert.equal(await readFile(timelinePath(store), "utf8"), before);
  }
  await applyTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: p.timeline.timeline.revision, sourceFingerprint: storyTimelineFingerprint(p),
    commands: [{ kind: "delete", clipId: "cl_video" }],
  });
  const after = productionOf(store); assert.ok(after.timeline?.status === "ready");
  assert.equal(after.timeline.timeline.tracks.flatMap(track => track.clips).length, 0);
});

it("refuses legacy audio splits after an overlay's ownership changes (#895)", async t => {
  const store = await WorldStore.open(await makeTempWorld()); t.after(() => store.close());
  const source = join(store.dir, "split-scope.mp4"); await writeFile(source, "legacy split scope fixture");
  const filed = await fileArtifact(store, { sourcePath: source, mediaProbe: probe, production: PRODUCTION });
  assert.ok(filed.outcome === "filed");
  const overlay = await placeOverlay(store, PRODUCTION, { artifactId: filed.artifact.id, startSec: 0, endSec: 2 });
  await setOwner(store, filed.artifact, "another-production");
  const cutPath = join(store.dir, "productions", PRODUCTION, "cut.json"), before = await readFile(cutPath, "utf8");
  await assert.rejects(splitOverlayAudio(store, PRODUCTION, overlay.id), /belongs to another production.*Import the file/);
  assert.equal(await readFile(cutPath, "utf8"), before);
  await removeOverlay(store, PRODUCTION, overlay.id);
  assert.equal(productionOf(store).cut.overlays.length, 0);
});

it("refuses a foreign master before creating its first timeline (#895)", async t => {
  const store = await WorldStore.open(await makeTempWorld()); t.after(() => store.close());
  const source = join(store.dir, "master-scope.wav"); await writeFile(source, "master scope fixture");
  const filed = await fileArtifact(store, { sourcePath: source, mediaProbe: probe, production: "another-production" });
  assert.ok(filed.outcome === "filed");
  await store.commit({ kind: "test-spine", source: "test", files: [{ path: `productions/${PRODUCTION}/spine.json`, action: "create", baseHash: null,
    content: JSON.stringify({ schemaVersion: 1, revision: 1, trackArtifactId: filed.artifact.id, markers: [], anchors: {}, updatedAt: store.now() }) + "\n",
  }] });
  const p = productionOf(store); assert.ok(p.spine);
  await assert.rejects(applyTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: null,
    sourceFingerprint: spineTimelineFingerprint(p, p.spine, 3), commands: [],
  }), /Master track cites artifact .*belongs to another production.*Import the file/);
  await assert.rejects(readFile(timelinePath(store), "utf8"), { code: "ENOENT" });
  for (const dryRun of [true, false]) await assert.rejects(stageEditorRequests(store, {
    conversationId: "cv_01J8G0000000000000000000C1", entryContext: { kind: "production", productionId: PRODUCTION }, now: store.now(), dryRun,
    requests: [{ summary: "Add a sound lane", commands: [{ kind: "add-track", trackId: "tr_new", trackKind: "audio", name: "Audio" }] }],
  }), /Master track cites artifact .*belongs to another production.*Import the file/);
  await assert.rejects(readFile(join(store.dir, "productions", PRODUCTION, "editor-requests.json"), "utf8"), { code: "ENOENT" });
});

it("checks every legacy bulk-save source format while allowing existing references to be removed (#895)", async t => {
  const store = await WorldStore.open(await makeTempWorld()); t.after(() => store.close());
  const artifact = store.getBundle().artifacts.find(a => a.kind === "audio")!;
  const entries = [{ artifactId: artifact.id, offsetSec: 0 }, { source: { kind: "artifact", artifactId: artifact.id }, offsetSec: 1 }];
  const overlay = { id: "ov_01J8G0000000000000000000Z1", artifactId: artifact.id, startSec: 0, endSec: 1, lane: 0, audio: "only" };
  const audio = (values: typeof entries) => [{ kind: "score", label: "Score", entries: values }];
  const cutPath = join(store.dir, "productions", PRODUCTION, "cut.json"), before = await readFile(cutPath, "utf8").catch(() => null);
  await setOwner(store, artifact, "another-production");
  for (const cut of [...entries.map(entry => ({ audio: audio([entry]), overlays: [] })), { audio: [], overlays: [overlay] }]) {
    await assert.rejects(saveAudioTracks(store, PRODUCTION, JSON.stringify(cut)), /belongs to another production.*Import the file/);
    assert.equal(await readFile(cutPath, "utf8").catch(() => null), before);
  }
  await setOwner(store, store.getBundle().artifacts.find(candidate => candidate.id === artifact.id)!, null);
  await saveAudioTracks(store, PRODUCTION, JSON.stringify({ audio: audio(entries), overlays: [overlay] }));
  await setOwner(store, artifact, "another-production");
  await saveAudioTracks(store, PRODUCTION, JSON.stringify({ audio: audio(entries.slice(1)), overlays: [overlay] }));
  await assert.rejects(saveAudioTracks(store, PRODUCTION, JSON.stringify({ audio: audio(entries), overlays: [overlay] })), /belongs to another production/);
  await saveAudioTracks(store, PRODUCTION, JSON.stringify({ audio: [], overlays: [] }));
  assert.deepEqual(productionOf(store).cut, { audio: [], overlays: [] });
});

it("the suggested import recovery makes a scoped file available and places it (#895)", async t => {
  const store = await WorldStore.open(await makeTempWorld()); t.after(() => store.close());
  const source = join(store.dir, "recover.wav"); await writeFile(source, "recoverable audio");
  const filed = await fileArtifact(store, { sourcePath: source, mediaProbe: probe, production: "another-production" });
  assert.ok(filed.outcome === "filed");
  const artifact = filed.artifact;
  const p = productionOf(store);
  const failures = await importEditorMedia(store, [join(store.dir, "artifacts", artifact.file)], {
    productionId: PRODUCTION, baseRevision: null, sourceFingerprint: storyTimelineFingerprint(p), destination: "append",
  }, { abandoned: () => false, mediaProbe: probe });
  assert.deepEqual(failures, []);
  assert.equal(store.getBundle().artifacts.find(a => a.id === artifact.id)!.production, undefined);
  const after = productionOf(store);
  const plan = buildRenderPlan({ production: after, timeline: after.timeline, artifacts: store.getBundle().artifacts, scope: { kind: "production" }, preset: "review-cut" });
  assert.ok(plan.ok);
  assert.equal(plan.plan.audio[0]!.path, `artifacts/${artifact.file}`);
});
