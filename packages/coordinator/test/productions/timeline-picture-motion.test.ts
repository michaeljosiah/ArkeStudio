import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultEffectClip, ProductionTimelineSchema, storyTimelineFingerprint, type TimelineCommand } from "@arke-studio/contracts";
import { previewProductionEditorRequest } from "../../src/productions/editor-requests.js";
import { applyHumanTimelineCommand, TimelineCommandRefused } from "../../src/productions/timeline.js";
import { carriesPictureMotion } from "../../src/productions/timeline-record.js";
import { EDITOR_PICTURE_MOTION_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const PRODUCTION = "saltlight", relativeTimeline = `productions/${PRODUCTION}/timeline.json`;

/** A still on the Picture track with drifting dust above it: everything a stills film had before a picture could move. */
async function placed() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => "2026-11-11T12:00:00.000Z" }); closeOnCleanup(() => store.close());
  const production = store.getBundle().productions.find(value => value.meta.id === PRODUCTION)!;
  const still = store.getBundle().artifacts.find(value => value.kind === "board")!;
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production), commands: [
    { kind: "place", trackId: "tr_picture", clip: { id: "cl_still", startFrame: 0, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: still.id, label: "Still" } } },
    { kind: "add-track", trackId: "tr_fx", trackKind: "effect", name: "Effects" },
    { kind: "effect-create", trackId: "tr_fx", effect: defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 0, durationFrames: 96, seed: 42 }) }] });
  const raw = () => readFile(join(store.dir, relativeTimeline), "utf8");
  const read = async () => ProductionTimelineSchema.parse(JSON.parse(await raw()));
  const send = async (commands: TimelineCommand[]) => applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: (await read()).revision,
    sourceFingerprint: storyTimelineFingerprint(production), commands });
  const version = async () => (await readWorldMeta(store.dir)).schemaVersion;
  return { store, production, raw, read, send, version };
}

test("the first move raises the world in the transaction that writes it, and Undo does not lower it", async () => {
  const { store, raw, read, send, version } = await placed();
  // An effect has a `motion` and `fades` of its own; neither is a picture's.
  assert.equal(carriesPictureMotion(await raw()), false);
  assert.ok(await version() < EDITOR_PICTURE_MOTION_SCHEMA_VERSION);
  await send([{ kind: "picture-motion", clipId: "cl_still", motion: { kind: "push-in", amount: .08 } }]);
  const moved = await read();
  assert.deepEqual(moved.tracks[0]!.clips[0]!.motion, { kind: "push-in", amount: .08 });
  assert.equal(await version(), EDITOR_PICTURE_MOTION_SCHEMA_VERSION);
  await assert.rejects(readWorldMeta(store.dir, { supports: EDITOR_PICTURE_MOTION_SCHEMA_VERSION - 1 }), /newer Arke Studio/);
  const lines = (await readFile(join(store.dir, "changes.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const raised = lines.find(line => line.entity === "world" && line.toVersion === EDITOR_PICTURE_MOTION_SCHEMA_VERSION);
  const written = lines.filter(line => line.path === relativeTimeline).at(-1);
  assert.ok(written && raised);
  assert.equal(written.commitId, raised.commitId, "an older build never sees the move without the boundary");
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: moved.revision });
  assert.equal((await read()).tracks[0]!.clips[0]!.motion, undefined);
  assert.equal(carriesPictureMotion(await raw()), true, "Redo still holds the move");
  assert.equal(await version(), EDITOR_PICTURE_MOTION_SCHEMA_VERSION);
});

test("a fade alone raises the world too, and a refused move writes nothing", async () => {
  const { raw, read, send, version } = await placed(), before = await raw();
  await assert.rejects(send([{ kind: "picture-motion", clipId: "cl_dust", motion: { kind: "drift-left", amount: .1 } }]), TimelineCommandRefused);
  assert.equal(await raw(), before);
  assert.ok(await version() < EDITOR_PICTURE_MOTION_SCHEMA_VERSION);
  await send([{ kind: "picture-fade", clipId: "cl_still", inFrames: 24 }]);
  assert.deepEqual((await read()).tracks[0]!.clips[0]!.fade, { inFrames: 24 });
  assert.equal(await version(), EDITOR_PICTURE_MOTION_SCHEMA_VERSION);
});

test("Arke's request can move and fade a still, and its card says what changes; a move on film is refused before a card", async () => {
  const { store, production, raw, send, version } = await placed(), scene = production.scenes[0]!, shot = "shots" in scene ? scene.shots[0]! : assert.fail("the fixture's first scene has shots");
  await send([{ kind: "place", trackId: "tr_picture", clip: { id: "cl_film", startFrame: 96, durationFrames: 48, sourceInFrames: 0,
    source: { kind: "shot", shotId: shot.id, sceneNumber: 1, shotNumber: 1, label: shot.id } } }]);
  const before = await raw(), ask = (commands: TimelineCommand[]) => previewProductionEditorRequest(store, PRODUCTION, { summary: "Move the still", commands: commands as never }, "2026-11-11T12:00:00.000Z");
  const preview = ask([{ kind: "picture-motion", clipId: "cl_still", motion: { kind: "push-in", amount: .1 } }, { kind: "picture-fade", clipId: "cl_still", inFrames: 24 }]);
  assert.equal(preview.ok, true);
  if (preview.ok) assert.match(preview.digest.effects[0]!.detail!, /-> tr_picture, frames 0-96, source 0-96, push-in 0\.1, fade in 24 out 0$/);
  assert.deepEqual(ask([{ kind: "picture-motion", clipId: "cl_film", motion: { kind: "push-in", amount: .1 } }]), { ok: false, reason: "Motion needs a still image" });
  assert.equal(ask([{ kind: "picture-fade", clipId: "cl_film", outFrames: 12 }]).ok, true, "film fades");
  assert.equal(await raw(), before, "a preview writes nothing");
  assert.ok(await version() < EDITOR_PICTURE_MOTION_SCHEMA_VERSION);
});
