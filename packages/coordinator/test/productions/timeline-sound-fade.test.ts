import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProductionTimelineSchema, storyTimelineFingerprint, type TimelineCommand } from "@arke-studio/contracts";
import { previewProductionEditorRequest } from "../../src/productions/editor-requests.js";
import { applyHumanTimelineCommand, TimelineCommandRefused } from "../../src/productions/timeline.js";
import { carriesPictureMotion, carriesSoundFade } from "../../src/productions/timeline-record.js";
import { EDITOR_SOUND_FADE_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const PRODUCTION = "saltlight", relativeTimeline = `productions/${PRODUCTION}/timeline.json`;

/** A still on the Picture track and a bed on a Music track: what a film has before its music can fade (SPEC-038 R-37). */
async function placed() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => "2026-11-13T12:00:00.000Z" }); closeOnCleanup(() => store.close());
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
  const song_ = async () => (await read()).tracks.find(track => track.id === "tr_music")!.clips[0]!;
  return { store, raw, read, send, version, song: song_ };
}

test("the first sound fade raises the world in the transaction that writes it, and Undo does not lower it", async () => {
  const { store, raw, read, send, version, song } = await placed();
  assert.equal(carriesSoundFade(await raw()), false);
  assert.ok(await version() < EDITOR_SOUND_FADE_SCHEMA_VERSION);
  await send([{ kind: "sound-fade", clipId: "cl_song", inFrames: 48, outFrames: 72 }]);
  assert.deepEqual((await song()).soundFade, { inFrames: 48, outFrames: 72 });
  assert.equal((await song()).gainDb, -6);
  assert.equal(await version(), EDITOR_SOUND_FADE_SCHEMA_VERSION);
  await assert.rejects(readWorldMeta(store.dir, { supports: EDITOR_SOUND_FADE_SCHEMA_VERSION - 1 }), /newer Arke Studio/);
  const lines = (await readFile(join(store.dir, "changes.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const raised = lines.find(line => line.entity === "world" && line.toVersion === EDITOR_SOUND_FADE_SCHEMA_VERSION);
  const written = lines.filter(line => line.path === relativeTimeline).at(-1);
  assert.ok(written && raised);
  assert.equal(written.commitId, raised.commitId, "an older build never sees the fade without the boundary");
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: (await read()).revision });
  assert.equal((await song()).soundFade, undefined);
  assert.equal(carriesSoundFade(await raw()), true, "Redo still holds the fade");
  assert.equal(await version(), EDITOR_SOUND_FADE_SCHEMA_VERSION);
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "redo", baseRevision: (await read()).revision });
  assert.deepEqual((await song()).soundFade, { inFrames: 48, outFrames: 72 });
});

test("a fade on a picture clip is refused and writes nothing, and a picture's own fade is not a sound's", async () => {
  const { raw, send, version } = await placed(), before = await raw();
  await assert.rejects(send([{ kind: "sound-fade", clipId: "cl_still", inFrames: 24 }]), TimelineCommandRefused);
  assert.equal(await raw(), before);
  await send([{ kind: "picture-fade", clipId: "cl_still", inFrames: 24 }]);
  assert.equal(carriesPictureMotion(await raw()), true);
  assert.equal(carriesSoundFade(await raw()), false, "the two floors are told apart by the field's name");
  assert.ok(await version() < EDITOR_SOUND_FADE_SCHEMA_VERSION);
});

test("the floor is read from a clip, from Undo and Redo, and from a request, and never from typed words", () => {
  const clip = { id: "cl_song", soundFade: { inFrames: 12 } };
  const carried: Array<[string, unknown]> = [
    ["a clip", { tracks: [{ kind: "music", clips: [clip] }] }],
    ["an Undo entry", { tracks: [], history: { undo: [{ kind: "change", clips: [{ before: clip, after: { id: "cl_song" } }] }], redo: [] } }],
    ["a Redo entry", { tracks: [], history: { undo: [], redo: [{ kind: "change", clips: [{ before: { id: "cl_song" }, after: clip }] }] } }],
    ["a request's command", { schemaVersion: 1, requests: [{ commands: [{ kind: "sound-fade", clipId: "cl_song", inFrames: 0 }] }] }],
    ["a request's placed clip", { schemaVersion: 1, requests: [{ commands: [{ kind: "place", trackId: "tr_music", clip }] }] }],
  ];
  for (const [where, value] of carried) assert.equal(carriesSoundFade(JSON.stringify(value)), true, where);
  const plain: Array<[string, unknown]> = [
    ["a picture's fade", { tracks: [{ kind: "picture", clips: [{ id: "cl_still", fade: { inFrames: 12 } }] }] }],
    ["an effect's fades", { tracks: [{ kind: "effect", effects: [{ id: "cl_dust", fades: { inFrames: 12, outFrames: 12 } }] }] }],
    ["words that say it", { tracks: [{ kind: "picture", clips: [{ source: { kind: "text", text: "soundFade", label: "sound-fade" } }] }] }],
    ["a summary that says it", { schemaVersion: 1, requests: [{ summary: "sound-fade the music", commands: [{ kind: "set-clip-gain", clipId: "cl_song", gainDb: -3 }] }] }],
  ];
  for (const [where, value] of plain) assert.equal(carriesSoundFade(JSON.stringify(value)), false, where);
  assert.equal(carriesSoundFade("not json"), false);
});

test("Arke's request can fade a sound clip, and its card says what changes; a fade on a picture clip is refused before a card", async () => {
  const { store, raw, version } = await placed();
  const before = await raw(), ask = (commands: TimelineCommand[]) => previewProductionEditorRequest(store, PRODUCTION, { summary: "Fade the music", commands: commands as never }, "2026-11-13T12:00:00.000Z");
  const preview = ask([{ kind: "sound-fade", clipId: "cl_song", inFrames: 48 }, { kind: "sound-fade", clipId: "cl_song", outFrames: 72 }]);
  assert.equal(preview.ok, true, preview.ok ? "" : preview.reason);
  if (preview.ok) assert.match(preview.digest.effects[0]!.detail!, /tr_music, frames 0-96, source 0-96, -6 dB -> tr_music, frames 0-96, source 0-96, -6 dB, sound fade in 48 out 72$/);
  assert.deepEqual(ask([{ kind: "sound-fade", clipId: "cl_still", inFrames: 24 }]), { ok: false, reason: "Choose a clip on an audio track" });
  assert.equal(await raw(), before, "a preview writes nothing");
  assert.ok(await version() < EDITOR_SOUND_FADE_SCHEMA_VERSION);
});
