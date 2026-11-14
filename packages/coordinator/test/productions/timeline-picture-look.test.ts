import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProductionTimelineSchema, storyTimelineFingerprint, textLookForNewClip, type TimelineCommand } from "@arke-studio/contracts";
import { previewProductionEditorRequest } from "../../src/productions/editor-requests.js";
import { applyHumanTimelineCommand, TimelineCommandRefused } from "../../src/productions/timeline.js";
import { carriesEditorText, carriesPictureLook } from "../../src/productions/timeline-record.js";
import { EDITOR_PICTURE_LOOK_SCHEMA_VERSION, EDITOR_SOUND_FADE_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const PRODUCTION = "saltlight", relativeTimeline = `productions/${PRODUCTION}/timeline.json`;

/** A still on the Picture track: a cut from before a film could carry a look (SPEC-038 R-45..R-50). */
async function placed() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => "2026-11-14T12:00:00.000Z" }); closeOnCleanup(() => store.close());
  const production = store.getBundle().productions.find(value => value.meta.id === PRODUCTION)!;
  const still = store.getBundle().artifacts.find(value => value.kind === "board")!;
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production), commands: [
    { kind: "place", trackId: "tr_picture", clip: { id: "cl_still", startFrame: 0, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: still.id, label: "Still" } } }] });
  const raw = () => readFile(join(store.dir, relativeTimeline), "utf8");
  const read = async () => ProductionTimelineSchema.parse(JSON.parse(await raw()));
  const send = async (commands: TimelineCommand[]) => applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: (await read()).revision,
    sourceFingerprint: storyTimelineFingerprint(production), commands });
  const version = async () => (await readWorldMeta(store.dir)).schemaVersion;
  return { store, raw, read, send, version };
}

test("the first look raises the world in the transaction that writes it, and Undo does not lower it", async () => {
  const { store, raw, read, send, version } = await placed();
  assert.equal(carriesPictureLook(await raw()), false);
  assert.ok(await version() < EDITOR_PICTURE_LOOK_SCHEMA_VERSION);
  await send([{ kind: "set-picture-look", look: { grade: "film", grain: "light" } }]);
  assert.deepEqual((await read()).pictureLook, { grade: "film", grain: "light" });
  assert.equal(EDITOR_PICTURE_LOOK_SCHEMA_VERSION, EDITOR_SOUND_FADE_SCHEMA_VERSION + 1, "the floor after sound fades");
  assert.equal(await version(), EDITOR_PICTURE_LOOK_SCHEMA_VERSION);
  await assert.rejects(readWorldMeta(store.dir, { supports: EDITOR_PICTURE_LOOK_SCHEMA_VERSION - 1 }), /newer Arke Studio/);
  const lines = (await readFile(join(store.dir, "changes.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const raised = lines.find(line => line.entity === "world" && line.toVersion === EDITOR_PICTURE_LOOK_SCHEMA_VERSION);
  const written = lines.filter(line => line.path === relativeTimeline).at(-1);
  assert.ok(written && raised);
  assert.equal(written.commitId, raised.commitId, "an older build never sees the look without the boundary");

  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: (await read()).revision });
  assert.equal("pictureLook" in JSON.parse(await raw()), false, "the film has no look again, and no key for one");
  assert.equal(carriesPictureLook(await raw()), true, "Redo still holds it");
  assert.equal(await version(), EDITOR_PICTURE_LOOK_SCHEMA_VERSION);
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "redo", baseRevision: (await read()).revision });
  assert.deepEqual((await read()).pictureLook, { grade: "film", grain: "light" });

  // Cleared by its own command, the record and its Undo are still ones an older Cut cannot read.
  await send([{ kind: "set-picture-look", look: null }]);
  assert.equal((await read()).pictureLook, undefined);
  assert.equal(carriesPictureLook(await raw()), true);
  assert.equal(await version(), EDITOR_PICTURE_LOOK_SCHEMA_VERSION);
});

test("a film without a look stays where it was, whatever else is edited, and clearing nothing writes nothing", async () => {
  const { raw, read, send, version } = await placed();
  await send([{ kind: "set-mix", mix: { duckingDb: -12 } }]);
  // A title has a `look` of its own, on its source: it raises the world for text and not for this.
  const title = { kind: "text" as const, text: "Ife", label: "Ife", look: textLookForNewClip(await read()) };
  await send([{ kind: "place", trackId: "tr_picture", clip: { id: "cl_title", startFrame: 96, durationFrames: 48, sourceInFrames: 0, source: title } }]);
  assert.equal(carriesEditorText(await raw()), true);
  assert.equal(carriesPictureLook(await raw()), false);
  assert.ok(await version() < EDITOR_PICTURE_LOOK_SCHEMA_VERSION);
  const before = await raw();
  await assert.rejects(send([{ kind: "set-picture-look", look: null }]), TimelineCommandRefused);
  assert.equal(await raw(), before);
  assert.ok(await version() < EDITOR_PICTURE_LOOK_SCHEMA_VERSION);
});

test("the floor is read from the record, from Undo and Redo, and from a command, and never from a title's look or typed words", () => {
  const film = { grade: "film" }, change = (before: unknown, after: unknown) => ({ kind: "change", label: "Change the look", clips: [], pictureLook: { before, after } });
  const carried: Array<[string, unknown]> = [
    ["the record", { tracks: [], pictureLook: { grain: "medium" }, history: { undo: [], redo: [] } }],
    ["an Undo entry that set it", { tracks: [], history: { undo: [change(null, film)], redo: [] } }],
    ["a Redo entry that cleared it", { tracks: [], history: { undo: [], redo: [change(film, null)] } }],
    ["a command in a request", { schemaVersion: 1, requests: [{ commands: [{ kind: "set-picture-look", look: null }] }] }],
    ["a look this build cannot read", { tracks: [], pictureLook: { grade: "a-later-grade", halation: 0.2 } }],
  ];
  for (const [where, value] of carried) assert.equal(carriesPictureLook(JSON.stringify(value)), true, where);
  const plain: Array<[string, unknown]> = [
    ["a title's look", { tracks: [{ kind: "picture", clips: [{ source: { kind: "text", text: "Ife", label: "Ife", look: { typeface: "eb-garamond", size: 0.1 } } }] }] }],
    ["a request that changes a title's look", { schemaVersion: 1, requests: [{ commands: [{ kind: "text-set", clipIds: ["cl_title"], look: { size: 0.2 } }] }] }],
    ["words that say it", { tracks: [{ kind: "picture", clips: [{ source: { kind: "text", text: "pictureLook", label: "set-picture-look" } }] }] }],
    ["a summary that says it", { schemaVersion: 1, requests: [{ summary: "set-picture-look to film", commands: [{ kind: "set-mix", mix: { duckingDb: -6 } }] }] }],
    ["the mix", { tracks: [], mix: { speechFirst: true }, history: { undo: [{ kind: "change", mix: { before: {}, after: {} } }], redo: [] } }],
  ];
  for (const [where, value] of plain) assert.equal(carriesPictureLook(JSON.stringify(value)), false, where);
  assert.equal(carriesPictureLook("not json"), false);
});

test("Arke's request does not carry the look: it is refused before a card and writes nothing", async () => {
  const { store, raw, version } = await placed(), before = await raw();
  const preview = previewProductionEditorRequest(store, PRODUCTION, { summary: "Grade the film", commands: [{ kind: "set-picture-look", look: { grade: "film" } }] as never }, "2026-11-14T12:00:00.000Z");
  assert.equal(preview.ok, false);
  assert.equal(await raw(), before);
  assert.ok(await version() < EDITOR_PICTURE_LOOK_SCHEMA_VERSION);
});
