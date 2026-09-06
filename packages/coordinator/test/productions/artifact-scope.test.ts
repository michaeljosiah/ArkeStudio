import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildRenderPlan, storyTimelineFingerprint, type ProductionBundle } from "@arke-studio/contracts";
import { fileArtifact, setOwner } from "../../src/artifacts/filing.js";
import { applyTimelineCommand } from "../../src/productions/timeline.js";
import { importEditorMedia } from "../../src/productions/editor-import.js";
import { placeOverlay } from "../../src/takes/review.js";
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
  await applyTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: p.timeline.timeline.revision, sourceFingerprint: storyTimelineFingerprint(p),
    commands: [{ kind: "delete", clipId: "cl_video" }],
  });
  const after = productionOf(store); assert.ok(after.timeline?.status === "ready");
  assert.equal(after.timeline.timeline.tracks.flatMap(track => track.clips).length, 0);
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
