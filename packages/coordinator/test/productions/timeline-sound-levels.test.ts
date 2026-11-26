import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProductionTimelineSchema, storyTimelineFingerprint, type TimelineCommand } from "@arke-studio/contracts";
import { previewProductionEditorRequest } from "../../src/productions/editor-requests.js";
import { applyHumanTimelineCommand, TimelineCommandRefused } from "../../src/productions/timeline.js";
import { carriesSoundFade, carriesSoundLevels } from "../../src/productions/timeline-record.js";
import { EDITOR_SOUND_FADE_SCHEMA_VERSION, EDITOR_SOUND_LEVELS_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const PRODUCTION = "saltlight", relativeTimeline = `productions/${PRODUCTION}/timeline.json`;

/** A still on the Picture track and a bed on a Music track: a film before its room's music is set under the talk (SPEC-038 R-52..R-56). */
async function placed() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => "2026-11-26T12:00:00.000Z" }); closeOnCleanup(() => store.close());
  const production = store.getBundle().productions.find(value => value.meta.id === PRODUCTION)!;
  const still = store.getBundle().artifacts.find(value => value.kind === "board")!, song = store.getBundle().artifacts.find(value => value.kind === "audio")!;
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production), commands: [
    { kind: "place", trackId: "tr_picture", clip: { id: "cl_still", startFrame: 0, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: still.id, label: "Still" } } },
    { kind: "add-track", trackId: "tr_music", trackKind: "music", name: "Music" },
    { kind: "place", trackId: "tr_music", clip: { id: "cl_song", startFrame: 0, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: song.id, label: "Song" }, gainDb: -6, role: "music" } }] });
  const raw = () => readFile(join(store.dir, relativeTimeline), "utf8");
  const read = async () => ProductionTimelineSchema.parse(JSON.parse(await raw()));
  const send = async (commands: TimelineCommand[]) => applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: (await read()).revision,
    sourceFingerprint: storyTimelineFingerprint(production), commands });
  const version = async () => (await readWorldMeta(store.dir)).schemaVersion;
  const music = async () => (await read()).tracks.find(track => track.id === "tr_music")!;
  return { store, raw, read, send, version, music };
}

test("a track's first level raises the world in the transaction that writes it, and Undo does not lower it", async () => {
  const { store, raw, read, send, version, music } = await placed();
  assert.equal(carriesSoundLevels(await raw()), false);
  assert.ok(await version() < EDITOR_SOUND_LEVELS_SCHEMA_VERSION);
  await send([{ kind: "set-track", trackId: "tr_music", levelDb: -6, ducks: false }]);
  assert.deepEqual([(await music()).levelDb, (await music()).ducks, (await music()).clips[0]!.gainDb], [-6, false, -6]);
  assert.equal(await version(), EDITOR_SOUND_LEVELS_SCHEMA_VERSION);
  await assert.rejects(readWorldMeta(store.dir, { supports: EDITOR_SOUND_LEVELS_SCHEMA_VERSION - 1 }), /newer Arke Studio/);
  const lines = (await readFile(join(store.dir, "changes.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const raised = lines.find(line => line.entity === "world" && line.toVersion === EDITOR_SOUND_LEVELS_SCHEMA_VERSION);
  const written = lines.filter(line => line.path === relativeTimeline).at(-1);
  assert.ok(written && raised);
  assert.equal(written.commitId, raised.commitId, "an older build never sees the level without the boundary");
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: (await read()).revision });
  assert.deepEqual(["levelDb" in await music(), "ducks" in await music()], [false, false]);
  assert.equal(carriesSoundLevels(await raw()), true, "Redo still holds the track as it was set");
  assert.equal(await version(), EDITOR_SOUND_LEVELS_SCHEMA_VERSION);
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "redo", baseRevision: (await read()).revision });
  assert.deepEqual([(await music()).levelDb, (await music()).ducks], [-6, false]);
});

test("an even-power fade raises the world above a straight one, and a level on the Picture track is refused and writes nothing", async () => {
  const { raw, send, version, read } = await placed(), before = await raw();
  await assert.rejects(send([{ kind: "set-track", trackId: "tr_picture", levelDb: -3 }]), TimelineCommandRefused);
  await assert.rejects(send([{ kind: "set-track", trackId: "tr_picture", ducks: false }]), TimelineCommandRefused);
  assert.equal(await raw(), before);
  await send([{ kind: "sound-fade", clipId: "cl_song", inFrames: 24 }]);
  assert.deepEqual([carriesSoundFade(await raw()), carriesSoundLevels(await raw()), await version()], [true, false, EDITOR_SOUND_FADE_SCHEMA_VERSION], "a straight fade is the floor it always was");
  await send([{ kind: "sound-fade", clipId: "cl_song", power: true }]);
  assert.deepEqual((await read()).tracks.find(track => track.id === "tr_music")!.clips[0]!.soundFade, { inFrames: 24, power: true });
  assert.equal(await version(), EDITOR_SOUND_LEVELS_SCHEMA_VERSION);
});

test("the floor is read from a track, from Undo and Redo, and from a request, and never from a clip's own gain or typed words", () => {
  const even = { id: "cl_song", soundFade: { inFrames: 12, power: true } };
  const carried: Array<[string, unknown]> = [
    ["a track's level", { tracks: [{ id: "tr_room", kind: "ambience", levelDb: -6, clips: [] }] }],
    ["a track's hold", { tracks: [{ id: "tr_room", kind: "ambience", ducks: false, clips: [] }] }],
    ["an Undo entry's track", { tracks: [], history: { undo: [{ kind: "change", clips: [], tracks: [{ trackId: "tr_room", kind: "ambience", before: { name: "Room", order: 3, muted: false, levelDb: -6 }, after: { name: "Room", order: 3, muted: false } }] }], redo: [] } }],
    ["a Redo entry's track", { tracks: [], history: { undo: [], redo: [{ kind: "change", clips: [], tracks: [{ trackId: "tr_room", kind: "ambience", before: { name: "Room", order: 3, muted: false }, after: { name: "Room", order: 3, muted: false, ducks: false } }] }] } }],
    ["a request's track command", { schemaVersion: 1, requests: [{ commands: [{ kind: "set-track", trackId: "tr_room", levelDb: 0 }] }] }],
    ["a request's hold", { schemaVersion: 1, requests: [{ commands: [{ kind: "set-track", trackId: "tr_room", ducks: true }] }] }],
    ["an even-power fade on a clip", { tracks: [{ kind: "music", clips: [even] }] }],
    ["an even-power fade in Undo", { tracks: [], history: { undo: [{ kind: "change", clips: [{ before: even, after: { id: "cl_song" } }] }], redo: [] } }],
    ["a request's fade shape", { schemaVersion: 1, requests: [{ commands: [{ kind: "sound-fade", clipId: "cl_song", power: false }] }] }],
    ["a request's placed clip", { schemaVersion: 1, requests: [{ commands: [{ kind: "place", trackId: "tr_music", clip: even }] }] }],
  ];
  for (const [where, value] of carried) assert.equal(carriesSoundLevels(JSON.stringify(value)), true, where);
  const plain: Array<[string, unknown]> = [
    ["a clip's own gain", { tracks: [{ kind: "music", clips: [{ id: "cl_song", gainDb: -6 }] }] }],
    ["a straight sound fade", { tracks: [{ kind: "music", clips: [{ id: "cl_song", soundFade: { inFrames: 12, outFrames: 12 } }] }] }],
    ["a straight fade's command", { schemaVersion: 1, requests: [{ commands: [{ kind: "sound-fade", clipId: "cl_song", inFrames: 12 }] }] }],
    ["the mix's own ducking", { tracks: [], mix: { speechFirst: true, duckingDb: -9, lookAheadMs: 80, releaseMs: 400, limiterCeilingDb: -1 } }],
    ["a track with neither", { tracks: [{ id: "tr_room", kind: "ambience", muted: false, solo: false, clips: [] }] }],
    ["words that say it", { tracks: [{ kind: "picture", clips: [{ source: { kind: "text", text: "levelDb ducks power", label: "ducks" } }] }] }],
    ["a summary that says it", { schemaVersion: 1, requests: [{ summary: "levelDb down, ducks false, power true", commands: [{ kind: "set-clip-gain", clipId: "cl_song", gainDb: -3 }] }] }],
  ];
  for (const [where, value] of plain) assert.equal(carriesSoundLevels(JSON.stringify(value)), false, where);
  assert.equal(carriesSoundLevels("not json"), false);
});

test("Arke's request can set a track's level and hold it under speech, and its card says what every clip on the track gets", async () => {
  const { store, raw, version } = await placed();
  const before = await raw(), ask = (commands: TimelineCommand[]) => previewProductionEditorRequest(store, PRODUCTION, { summary: "Bring the room's music down and hold it", commands: commands as never }, "2026-11-26T12:00:00.000Z");
  const preview = ask([{ kind: "set-track", trackId: "tr_music", levelDb: -6, ducks: false }, { kind: "sound-fade", clipId: "cl_song", inFrames: 48, power: true }]);
  assert.equal(preview.ok, true, preview.ok ? "" : preview.reason);
  if (preview.ok) {
    assert.deepEqual(preview.digest.tracks, ["changes tr_music (level 0 dB -> -6 dB, holds under speech)"]);
    assert.match(preview.digest.effects[0]!.detail!, /-6 dB -> tr_music, frames 0-96, source 0-96, -6 dB, sound fade in 48 out 0 even-power$/);
  }
  // A track changed some other way says no more than it did.
  const renamed = ask([{ kind: "set-track", trackId: "tr_music", name: "Club" }]);
  if (renamed.ok) assert.deepEqual(renamed.digest.tracks, ["changes tr_music"]); else assert.fail(renamed.reason);
  assert.deepEqual(ask([{ kind: "set-track", trackId: "tr_picture", levelDb: -6 }]), { ok: false, reason: "Picture is not an audio track and has no level" });
  assert.equal(await raw(), before, "a preview writes nothing");
  assert.ok(await version() < EDITOR_SOUND_LEVELS_SCHEMA_VERSION);
});
