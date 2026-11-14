import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultEffectClip, ProductionTimelineSchema, storyTimelineFingerprint, type TimelineCommand } from "@arke-studio/contracts";
import { previewProductionEditorRequest } from "../../src/productions/editor-requests.js";
import { applyHumanTimelineCommand, TimelineCommandRefused } from "../../src/productions/timeline.js";
import { carriesClipSpeed } from "../../src/productions/timeline-record.js";
import { EDITOR_CLIP_SPEED_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const PRODUCTION = "saltlight", relativeTimeline = `productions/${PRODUCTION}/timeline.json`;

/** A still, then a shot's film, with drifting dust above them: a cut from before a clip could be re-timed. */
async function placed() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => "2026-11-13T12:00:00.000Z" }); closeOnCleanup(() => store.close());
  const production = store.getBundle().productions.find(value => value.meta.id === PRODUCTION)!;
  const still = store.getBundle().artifacts.find(value => value.kind === "board")!;
  const scene = production.scenes[0]!, shot = "shots" in scene ? scene.shots[0]! : assert.fail("the fixture's first scene has shots");
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production), commands: [
    { kind: "place", trackId: "tr_picture", clip: { id: "cl_still", startFrame: 0, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: still.id, label: "Still" } } },
    { kind: "place", trackId: "tr_picture", clip: { id: "cl_film", startFrame: 96, durationFrames: 48, sourceInFrames: 0, source: { kind: "shot", shotId: shot.id, sceneNumber: 1, shotNumber: 1, label: shot.id } } },
    { kind: "add-track", trackId: "tr_fx", trackKind: "effect", name: "Effects" },
    { kind: "effect-create", trackId: "tr_fx", effect: defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 0, durationFrames: 96, seed: 42 }) }] });
  const raw = () => readFile(join(store.dir, relativeTimeline), "utf8");
  const read = async () => ProductionTimelineSchema.parse(JSON.parse(await raw()));
  const send = async (commands: TimelineCommand[]) => applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: (await read()).revision,
    sourceFingerprint: storyTimelineFingerprint(production), commands });
  const version = async () => (await readWorldMeta(store.dir)).schemaVersion;
  const film = async () => (await read()).tracks[0]!.clips.find(clip => clip.id === "cl_film")!;
  return { store, raw, read, send, version, film };
}

test("the first speed raises the world in the transaction that writes it, and Undo does not lower it", async () => {
  const { store, raw, read, send, version, film } = await placed();
  // An effect's motion has a speed of its own; it is not a clip's.
  assert.equal(carriesClipSpeed(await raw()), false);
  assert.ok(await version() < EDITOR_CLIP_SPEED_SCHEMA_VERSION);
  await send([{ kind: "set-clip-speed", clipId: "cl_film", speed: .5 }]);
  const slowed = await read();
  assert.deepEqual([(await film()).speed, (await film()).durationFrames], [.5, 96], "the same frames take twice as long");
  assert.equal(await version(), EDITOR_CLIP_SPEED_SCHEMA_VERSION);
  await assert.rejects(readWorldMeta(store.dir, { supports: EDITOR_CLIP_SPEED_SCHEMA_VERSION - 1 }), /newer Arke Studio/);
  const lines = (await readFile(join(store.dir, "changes.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const raised = lines.find(line => line.entity === "world" && line.toVersion === EDITOR_CLIP_SPEED_SCHEMA_VERSION);
  const written = lines.filter(line => line.path === relativeTimeline).at(-1);
  assert.ok(written && raised);
  assert.equal(written.commitId, raised.commitId, "an older build never sees the speed without the boundary");
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: slowed.revision });
  assert.deepEqual([(await film()).speed, (await film()).durationFrames], [undefined, 48]);
  assert.equal(carriesClipSpeed(await raw()), true, "Redo still holds the speed");
  assert.equal(await version(), EDITOR_CLIP_SPEED_SCHEMA_VERSION);
});

test("a direction alone raises the world too, and a speed on a still writes nothing", async () => {
  const { raw, send, version, film } = await placed(), before = await raw();
  await assert.rejects(send([{ kind: "set-clip-speed", clipId: "cl_still", speed: 2 }]), TimelineCommandRefused);
  await assert.rejects(send([{ kind: "set-clip-reverse", clipId: "cl_dust" as never, reverse: true }]), TimelineCommandRefused);
  assert.equal(await raw(), before);
  assert.ok(await version() < EDITOR_CLIP_SPEED_SCHEMA_VERSION);
  await send([{ kind: "set-clip-reverse", clipId: "cl_film", reverse: true }]);
  assert.equal((await film()).reverse, true);
  assert.equal(await version(), EDITOR_CLIP_SPEED_SCHEMA_VERSION);
});

test("Arke's request can slow a film and turn it round, and its card says so; a speed on a still is refused before a card", async () => {
  const { store, raw, version } = await placed(), before = await raw();
  const ask = (commands: TimelineCommand[]) => previewProductionEditorRequest(store, PRODUCTION, { summary: "Slow the film", commands: commands as never }, "2026-11-13T12:00:00.000Z");
  const preview = ask([{ kind: "set-clip-speed", clipId: "cl_film", speed: .5 }, { kind: "set-clip-reverse", clipId: "cl_film", reverse: true }]);
  assert.equal(preview.ok, true);
  if (preview.ok) assert.match(preview.digest.effects[0]!.detail!, /frames 96-144, source 0-48 -> tr_picture, frames 96-192, source 0-96, speed 0\.5x, backwards$/);
  assert.deepEqual(ask([{ kind: "set-clip-speed", clipId: "cl_still", speed: 2 }]), { ok: false, reason: "Speed and direction need a video" });
  assert.deepEqual(ask([{ kind: "set-clip-reverse", clipId: "cl_still", reverse: true }]), { ok: false, reason: "Speed and direction need a video" });
  assert.equal(await raw(), before, "a preview writes nothing");
  assert.ok(await version() < EDITOR_CLIP_SPEED_SCHEMA_VERSION);
});
