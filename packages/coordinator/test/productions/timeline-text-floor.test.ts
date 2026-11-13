import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultEffectClip, ProductionTimelineSchema, storyTimelineFingerprint, TEXT_PICTURE_DIR, TextLookSchema, TextSourceSchema, TimelineCommandSchema,
  type ModelEditorRequest, type TextLook, type TimelineClip, type TimelineCommand } from "@arke-studio/contracts";
import { stageEditorRequests } from "../../src/productions/editor-requests.js";
import { applyHumanTimelineCommand, TimelineCommandRefused } from "../../src/productions/timeline.js";
import { carriesEditorEffects, carriesEditorTransitions, carriesEditorAppearance, carriesPictureMotion, carriesEditorText } from "../../src/productions/timeline-record.js";
import { EDITOR_APPEARANCE_SCHEMA_VERSION, EDITOR_TEXT_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * The floor a text clip raises (SPEC-065 R-27), read off the bytes about to be written. Three
 * things have to hold for that to be safe, and each is a test here: a text source raises its own
 * floor and no older one, no record written before text existed raises it (R-40), and a text
 * source this build cannot read raises it all the same, because an older Cut cannot read it either.
 */

const PRODUCTION = "saltlight", NOW = "2026-11-11T12:00:00.000Z";
const relativeTimeline = `productions/${PRODUCTION}/timeline.json`, relativeRequests = `productions/${PRODUCTION}/editor-requests.json`;

const LOOK = { typeface: "geist", weight: "regular", italic: false, size: 0.08, tracking: 0, leading: 1.2,
  capitals: false, align: "center", x: 0.5, y: 0.5, room: 0.8, fill: { kind: "solid", color: "#ffffff" } } as const;
/** Every part a look can hold, so a look that gains a field has to come here to be drawn in full. */
const EVERYTHING: TextLook = { ...LOOK, fill: { kind: "gradient", stops: [{ at: 0, color: "#ffd27a" }, { at: 1, color: "#b0401c" }] },
  edge: { color: "#000000", width: 0.02 }, shadow: { color: "#000000", opacity: 0.6, blur: 0.2, dx: 0.03, dy: 0.05 },
  rule: { length: 0.4, weight: 0.02, gap: 0.3, soft: true }, backing: { kind: "box", color: "#101010", opacity: 0.5 } };
const SHADED: TextLook = { ...LOOK, backing: { kind: "shade", color: "#000000", opacity: 0.4 } };
const name = (id: string, startFrame: number, look: object = LOOK) => ({ id, startFrame, durationFrames: 112, sourceInFrames: 0,
  source: { kind: "text" as const, label: "Ife", text: "Ife", look } });

/** What the walkers for 74, 76, 77 and 129 read as their own, whatever object it sits in. */
const OLDER_KEYS = ["visual", "visualOriginId", "blendMode", "texture", "softness", "depth", "airflow", "particleDeflections", "pictureFamilies",
  "fade", "motion", "transitions", "effects", "effectClips", "effectProtection", "seed", "property", "boundary", "patch"];
const OLDER_KINDS = ["effect", "effect-patch", "picture-motion", "picture-fade"];
const older = (raw: string) => ({ effects: carriesEditorEffects(raw), transitions: carriesEditorTransitions(raw),
  appearance: carriesEditorAppearance(raw), motion: carriesPictureMotion(raw) });
const NONE = { effects: false, transitions: false, appearance: false, motion: false };

/** Every key under a value, and every value held under a key named `kind`. */
function named(value: unknown, keys = new Set<string>(), kinds = new Set<string>()): { keys: Set<string>; kinds: Set<string> } {
  if (Array.isArray(value)) for (const row of value) named(row, keys, kinds);
  else if (value && typeof value === "object") for (const [key, held] of Object.entries(value)) {
    keys.add(key);
    if (key === "kind" && typeof held === "string") kinds.add(held);
    named(held, keys, kinds);
  }
  return { keys, kinds };
}

/** A timeline as the file holds one, cut down to what a walker walks: the tracks, and Undo and Redo. */
const timelineBytes = (clips: object[], undo: object[] = [], redo: object[] = []) => JSON.stringify({ schemaVersion: 1, revision: 4,
  tracks: [{ id: "tr_picture", kind: "picture", name: "Picture", clips }], history: { undo, redo } }, null, 2) + "\n";
const change = (label: string, clipId: string, before: object | null, after: object | null) => ({ kind: "change", label,
  clips: [{ trackId: "tr_picture", clipId, before, after }], selections: [], tracks: [], cues: [] });
/** A request file likewise: the commands of each request are all a walker finds in it. */
const requestBytes = (commands: object[], more: object = {}, schemaVersion = 1) => JSON.stringify({ schemaVersion, requests: [{ id: "req_01J8G0000000000000000000R1",
  productionId: PRODUCTION, conversationId: "cv_01J8G0000000000000000000C1", baseRevision: 4, commands, summary: "Change the cut", createdAt: NOW, status: "pending" }], ...more }, null, 2) + "\n";
const STILL = { id: "cl_still", startFrame: 0, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: "ar_01J8G0000000000000000000R3", label: "Still" } };

test("no part of a text clip's source trips an older walker", () => {
  // The fixtures are the shapes a write accepts, and between them they hold every field a look has.
  for (const look of [LOOK, EVERYTHING, SHADED]) TextSourceSchema.parse(name("cl_name", 0, look).source);
  assert.deepEqual(Object.keys(TextLookSchema.shape).filter(key => !(key in EVERYTHING)), [], "a new look field is drawn in EVERYTHING");
  const set: TimelineCommand[] = [
    { kind: "text-set", clipIds: ["cl_name"], text: "Ife\nof the Undersong", look: EVERYTHING },
    { kind: "text-set", clipIds: ["cl_name", "cl_title"], look: { size: 0.1, fill: LOOK.fill, edge: null, shadow: null, rule: null, backing: null } },
  ];
  for (const command of set) TimelineCommandSchema.parse(command);
  const option = TimelineCommandSchema.options.find(row => row.shape.kind.value === "text-set");
  assert.ok(option, "text-set is a timeline command");
  assert.deepEqual(Object.keys(option.shape).filter(key => !(key in set[0]!)), [], "a new text-set field is sent in the first command");

  // A look must never gain a key an older walker reads as its own, and a text-set carries its
  // look under `look`: a `patch` holding a `seed` is how an effect's reseed is read (schema 77).
  const { keys, kinds } = named([name("cl_name", 0, EVERYTHING).source, name("cl_shaded", 0, SHADED).source, ...set]);
  assert.deepEqual(OLDER_KEYS.filter(key => keys.has(key)), []);
  assert.deepEqual(OLDER_KINDS.filter(kind => kinds.has(kind)), []);

  // No clip here has the `visualOriginId` a place stamps or a `fade`: those raise 77 and 129
  // truthfully, and would hide a source that did so by accident.
  const records: Array<[string, string]> = [
    ["the source alone", JSON.stringify(name("cl_name", 0, EVERYTHING).source)],
    ["on a track", timelineBytes([STILL, name("cl_name", 96, EVERYTHING), name("cl_shaded", 208, SHADED)])],
    ["in Undo", timelineBytes([STILL], [change("Delete Ife", "cl_name", name("cl_name", 96, EVERYTHING), null)])],
    ["in Redo", timelineBytes([STILL], [], [change("Place Ife on tr_picture", "cl_name", null, name("cl_name", 96, EVERYTHING))])],
    ["a changed look in Undo", timelineBytes([STILL, name("cl_name", 96, EVERYTHING)], [change("Change text", "cl_name", name("cl_name", 96), name("cl_name", 96, EVERYTHING))])],
    ["placed by a request", requestBytes([{ kind: "place", trackId: "tr_picture", clip: name("cl_name", 96, EVERYTHING) }])],
    ["set by a request", requestBytes(set)],
  ];
  for (const [where, raw] of records) {
    assert.deepEqual(older(raw), NONE, where);
    assert.equal(carriesEditorText(raw), true, where);
  }
});

/** A line of `changes.jsonl`, as far as these tests read one. */
interface ChangeLine { entity?: string; path?: string; commitId?: string; fieldsChanged?: string[]; fromVersion?: number; toVersion?: number }

/** The fixture world, with its cut written as a person writes it: every write through the one commit funnel. */
async function world() {
  const dir = await makeTempWorld();
  let store = await WorldStore.open(dir, { clock: () => NOW }); closeOnCleanup(() => store.close());
  const production = () => store.getBundle().productions.find(value => value.meta.id === PRODUCTION)!;
  const still = store.getBundle().artifacts.find(value => value.kind === "board")!;
  const raw = () => readFile(join(dir, relativeTimeline), "utf8");
  const read = async () => ProductionTimelineSchema.parse(JSON.parse(await raw()));
  // The saltlight production has no timeline until the first write makes one.
  const revision = async () => { try { return (await read()).revision; } catch { return null; } };
  const send = async (commands: TimelineCommand[]) => applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands",
    baseRevision: await revision(), sourceFingerprint: storyTimelineFingerprint(production()), commands });
  const undo = async () => applyHumanTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: (await read()).revision });
  const version = async () => (await readWorldMeta(dir)).schemaVersion;
  const worldBytes = () => readFile(join(dir, "world.json"), "utf8");
  const changes = async (): Promise<ChangeLine[]> => (await readFile(join(dir, "changes.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const placeStill = (id: `cl_${string}`, startFrame: number): TimelineCommand => ({ kind: "place", trackId: "tr_picture",
    clip: { id, startFrame, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: still.id, label: "Still" } } });
  /**
   * Closes the world, sets its floor by hand and opens it again: the only way to show that a later
   * write raises the floor by itself, since nothing the app does ever lowers it.
   */
  const reopenAt = async (schemaVersion: number) => {
    await store.close();
    const before = await worldBytes(), after = before.replace(/"schemaVersion": \d+/, `"schemaVersion": ${schemaVersion}`);
    assert.notEqual(after, before, "world.json names its floor");
    await writeFile(join(dir, "world.json"), after, "utf8");
    store = await WorldStore.open(dir, { clock: () => NOW });
  };
  return { get store() { return store; }, dir, still, raw, read, send, undo, version, worldBytes, changes, placeStill, reopenAt };
}

/** A text clip as a write accepts one, typed plainly so that what is stored is what was sent. */
const textClip = (id: `cl_${string}`, startFrame: number, words = "Ife", look: TextLook = LOOK): TimelineClip =>
  ({ id, startFrame, durationFrames: 112, sourceInFrames: 0, source: { kind: "text", label: words, text: words, look } });
const holdsText = (timeline: { tracks: Array<{ clips: TimelineClip[] }> }) => timeline.tracks.some(track => track.clips.some(clip => clip.source.kind === "text"));

/** The cut a stills film had before text: two halves of a still, with Undo and Redo both holding something. */
async function legacy() {
  const cut = await world();
  await cut.send([cut.placeStill("cl_still", 0)]);
  await cut.send([{ kind: "split", clipId: "cl_still", atFrame: 48, newClipId: "cl_tail" }]);
  await cut.send([{ kind: "delete", clipId: "cl_tail" }]);
  await cut.undo();
  return cut;
}

test("no legacy record trips the text walker", async () => {
  // Real bytes first: what this build writes for a cut with no text in it (SPEC-065 R-40).
  const { store, still, raw, read, send, undo, version } = await legacy();
  const plain = await read();
  assert.ok(plain.history.undo.length > 0 && plain.history.redo.length > 0, "Undo and Redo both hold something");
  assert.equal(carriesEditorText(await raw()), false);

  // Then everything the four floors before this one fence, on the tracks and in history.
  await send([{ kind: "add-track", trackId: "tr_fx", trackKind: "effect", name: "Effects" },
    { kind: "effect-create", trackId: "tr_fx", effect: defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 0, durationFrames: 96, seed: 42 }) }]);
  await send([{ kind: "picture-motion", clipId: "cl_still", motion: { kind: "push-in", amount: .08 } }, { kind: "picture-fade", clipId: "cl_still", inFrames: 12 }]);
  await send([{ kind: "transition-set", trackId: "tr_picture", leftClipId: "cl_still", rightClipId: "cl_tail", durationFrames: 12 }]);
  await send([{ kind: "picture-fade", clipId: "cl_tail", outFrames: 12 }]);
  await undo();
  const full = await read(), fullBytes = await raw();
  assert.ok(full.history.undo.length > 0 && full.history.redo.length > 0);
  assert.deepEqual(older(fullBytes), { effects: true, transitions: true, appearance: true, motion: true }, "the record holds what the older floors fence");
  assert.equal(carriesEditorText(fullBytes), false);

  // A request file as staging writes it: a still placed under the label `text`, and a move.
  const commands: ModelEditorRequest["commands"] = [
    { kind: "place", trackId: "tr_picture", clip: { id: "cl_more", startFrame: 96, durationFrames: 48, sourceInFrames: 0, source: { kind: "artifact", artifactId: still.id, label: "text" } } },
    { kind: "picture-motion", clipId: "cl_more", motion: { kind: "drift-left", amount: .1 } }];
  await stageEditorRequests(store, { conversationId: "cv_01J8G0000000000000000000C1", entryContext: { kind: "production", productionId: PRODUCTION },
    requests: [{ summary: "Add a text card", commands }], now: NOW });
  const staged = await readFile(join(store.dir, relativeRequests), "utf8");
  assert.match(staged, /"label": "text"/);
  assert.equal(carriesEditorText(staged), false);
  assert.ok(await version() < EDITOR_TEXT_SCHEMA_VERSION, "none of it raised the world to the text floor");

  // By hand, what the fixture cannot make cheaply: a request file of each version with a family
  // of every sort beside its requests, and words that say `text` everywhere but under `kind`.
  const families = { effectFamilies: [{ id: "efp_01J8G0000000000000000000F1", productionId: PRODUCTION, scope: { kind: "effects-only", target: { kind: "composition" } },
    versions: [{ id: "efv_01J8G0000000000000000000V1", commands: [{ kind: "effect-patch", clipId: "cl_dust", patch: { seed: 7 } }] }] }],
    transitionFamilies: [{ id: "trp_01J8G0000000000000000000F1", commands: [{ kind: "transition-set", trackId: "tr_picture", leftClipId: "cl_still", rightClipId: "cl_tail", durationFrames: 12 }] }],
    pictureFamilies: [{ id: "pcp_01J8G0000000000000000000F1", commands: [{ kind: "picture-appearance", clipId: "cl_still", visual: { blendMode: "screen" } }] }] };
  const placeStill = { kind: "place", trackId: "tr_picture", clip: { ...STILL, source: { ...STILL.source, label: "text" } } };
  const records: Array<[string, string]> = [
    ["a first-version request file", requestBytes([placeStill, { kind: "picture-motion", clipId: "cl_still", motion: { kind: "push-in", amount: .08 } }])],
    ["a second-version request file", requestBytes([placeStill, { kind: "picture-fade", clipId: "cl_still", inFrames: 24 }], families, 2)],
    ["a clip, a track and an entry named text", timelineBytes([{ ...STILL, source: { ...STILL.source, label: "text" } }], [change("text", "cl_still", null, STILL)])
      .replace('"name": "Picture"', '"name": "text"')],
    ["a cue whose words are a kind", JSON.stringify({ tracks: [{ id: "tr_subs", kind: "subtitle", name: "text-set", language: "en", clips: [],
      cues: [{ id: "cue_one", text: '"kind": "text"', startFrame: 0, endFrame: 48 }, { id: "cue_two", text: '{ "kind": "text-set" }', startFrame: 48, endFrame: 96 }] }] })],
    ["a text key that is not a kind", JSON.stringify({ text: "text", label: "text", look: "text", source: "text", type: "text", kinds: ["text", "text-set"] })],
    ["a kind a letter away", JSON.stringify([{ kind: "Text" }, { kind: "texts" }, { kind: "text_set" }, { kind: ["text"] }, { kind: { text: true } }])],
    ["bytes that are not a record", "not json"],
    ["a file cut short", '{ "tracks": [{ "clips": [{ "source": { "kind": "text"'],
    ["nothing", ""],
  ];
  for (const [where, bytes] of records) assert.equal(carriesEditorText(bytes), false, where);
  assert.match(records[2]![1], /"name": "text"/);

  // Every `kind` either file could hold before text: none is the one the walker reads.
  const kinds = ["picture", "audio", "dialogue", "ambience", "music", "subtitle", "effect", "performance", "shot", "take", "artifact",
    "timeline-track", "timeline-clip", "scene", "passage", "chapter", "board", "edge", "rename", "effect-arrangement", "change",
    ...TimelineCommandSchema.options.map(row => row.shape.kind.value).filter(kind => kind !== "text-set")];
  for (const kind of kinds) assert.equal(carriesEditorText(JSON.stringify({ tracks: [{ kind, clips: [{ source: { kind } }] }], history: { undo: [{ kind }], redo: [] } })), false, kind);
});

test("a broken text source still counts", async () => {
  // No look, no words, no label: nothing this build would write, and nothing an older Cut can read.
  const broken = { ...STILL, id: "cl_name", source: { kind: "text" } };
  assert.equal(TextSourceSchema.safeParse(broken.source).success, false);
  const records: Array<[string, string]> = [
    ["a source with no look, in Undo", timelineBytes([STILL], [change("Delete Ife", "cl_name", broken, null)])],
    ["a source with no look, in Redo", timelineBytes([STILL], [], [change("Place Ife on tr_picture", "cl_name", null, broken)])],
    ["a source with no look, on a track", timelineBytes([STILL, broken])],
    ["a text-set that names nothing, in a request", requestBytes([{ kind: "delete", clipId: "cl_still" }, { kind: "text-set" }])],
    ["a later build's source", timelineBytes([{ ...STILL, id: "cl_name", source: { kind: "text", label: "Ife", text: "Ife", look: { ...LOOK, typeface: "a-face-of-later", glow: { radius: 0.2 } }, runs: [{ from: 0, to: 3, weight: "bold" }] } }])],
    ["a source where a look should be", JSON.stringify({ look: { kind: "text" } })],
  ];
  for (const [where, raw] of records) assert.equal(carriesEditorText(raw), true, where);

  // And the funnel reads the same bytes: a record adopted from outside, which no reducer parsed,
  // raises the world in the commit that writes it rather than being left for an older build to open.
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => NOW }); closeOnCleanup(() => store.close());
  const version = async () => (await readWorldMeta(store.dir)).schemaVersion;
  assert.ok(await version() < EDITOR_TEXT_SCHEMA_VERSION);
  await store.commit({ kind: "adopt-timeline", source: "test", files: [{ path: relativeTimeline, action: "create", content: records[0]![1], baseHash: null }] });
  assert.equal(await version(), EDITOR_TEXT_SCHEMA_VERSION);
  await assert.rejects(readWorldMeta(store.dir, { supports: EDITOR_TEXT_SCHEMA_VERSION - 1 }), /newer Arke Studio/);
});

test("the first text clip raises the world in the transaction that writes it, and an older build refuses the world", async () => {
  const cut = await world();
  await cut.send([cut.placeStill("cl_still", 0)]);
  const floor = await cut.version();
  assert.equal(carriesEditorText(await cut.raw()), false);
  assert.ok(floor < EDITOR_TEXT_SCHEMA_VERSION);
  await cut.send([{ kind: "place", trackId: "tr_picture", clip: textClip("cl_name", 96) }]);
  assert.equal(await cut.version(), EDITOR_TEXT_SCHEMA_VERSION);
  const lines = await cut.changes();
  const raised = lines.filter(line => line.entity === "world" && line.toVersion === EDITOR_TEXT_SCHEMA_VERSION);
  const written = lines.filter(line => line.path === relativeTimeline).at(-1);
  assert.equal(raised.length, 1);
  assert.deepEqual(raised[0]!.fieldsChanged, ["schemaVersion"]);
  assert.equal(raised[0]!.fromVersion, floor);
  assert.equal(written?.commitId, raised[0]!.commitId, "an older build never sees the words without the boundary");

  // An older build reads world.json before anything else in a world, whichever way it comes in,
  // and stops there: nothing reads the timeline, so nothing can strip the clip from it.
  const cutBefore = await cut.raw(), metaBefore = await cut.worldBytes();
  await assert.rejects(readWorldMeta(cut.dir, { supports: EDITOR_TEXT_SCHEMA_VERSION - 1 }), /newer Arke Studio/);
  assert.equal(await cut.raw(), cutBefore, "the refusal changes nothing");
  assert.equal(await cut.worldBytes(), metaBefore);
  assert.deepEqual((await cut.read()).tracks.flatMap(track => track.clips).find(clip => clip.id === "cl_name")?.source, textClip("cl_name", 96).source);
});

test("a timeline whose only text is in Undo still raises the floor", async () => {
  const cut = await world();
  await cut.send([cut.placeStill("cl_still", 0)]);
  await cut.send([{ kind: "place", trackId: "tr_picture", clip: textClip("cl_name", 96) }]);
  assert.equal(await cut.version(), EDITOR_TEXT_SCHEMA_VERSION);
  // The floor never comes down, so the delete could only be seen to raise it from below: put it
  // back a step by hand first, as no build would.
  await cut.reopenAt(EDITOR_TEXT_SCHEMA_VERSION - 1);
  assert.equal(await cut.version(), EDITOR_TEXT_SCHEMA_VERSION - 1);
  await cut.send([{ kind: "delete", clipId: "cl_name" }]);
  const timeline = await cut.read(), bytes = await cut.raw();
  assert.equal(holdsText(timeline), false, "no clip on any track is text");
  assert.equal(carriesEditorText(JSON.stringify(timeline.history.redo)), false);
  assert.equal(carriesEditorText(JSON.stringify(timeline.history.undo)), true, "Undo holds the name, to put it back");
  assert.equal(carriesEditorText(bytes), true);
  assert.equal(await cut.version(), EDITOR_TEXT_SCHEMA_VERSION);
  const lines = await cut.changes();
  const raised = lines.filter(line => line.entity === "world" && line.fromVersion === EDITOR_TEXT_SCHEMA_VERSION - 1);
  assert.equal(raised.length, 1);
  assert.equal(raised[0]!.toVersion, EDITOR_TEXT_SCHEMA_VERSION);
  assert.equal(lines.filter(line => line.path === relativeTimeline).at(-1)?.commitId, raised[0]!.commitId, "the delete's own commit raised it");
  await assert.rejects(readWorldMeta(cut.dir, { supports: EDITOR_TEXT_SCHEMA_VERSION - 1 }), /newer Arke Studio/);
});

test("text only in Redo still carries the floor, and nothing lowers it", async () => {
  const cut = await world();
  await cut.send([cut.placeStill("cl_still", 0)]);
  await cut.send([{ kind: "place", trackId: "tr_picture", clip: textClip("cl_name", 96) }]);
  await cut.undo();
  const undone = await cut.read();
  assert.equal(holdsText(undone), false);
  assert.equal(carriesEditorText(JSON.stringify(undone.history.undo)), false);
  assert.equal(carriesEditorText(JSON.stringify(undone.history.redo)), true, "Redo holds the name");
  assert.equal(carriesEditorText(await cut.raw()), true);
  assert.equal(await cut.version(), EDITOR_TEXT_SCHEMA_VERSION);

  // An edit with no text in it clears Redo, so the record holds no text at all. The world stays
  // where it is: an older build that opened it now would find nothing to refuse, but the funnel
  // only ever raises, and a floor that came down could not be trusted to go back up in time.
  await cut.send([{ kind: "split", clipId: "cl_still", atFrame: 48, newClipId: "cl_tail" }]);
  const split = await cut.read();
  assert.deepEqual(split.history.redo, []);
  assert.equal(carriesEditorText(await cut.raw()), false);
  assert.equal(await cut.version(), EDITOR_TEXT_SCHEMA_VERSION);
});

test("a refused text place writes nothing and raises nothing", async () => {
  const cut = await world();
  await cut.send([cut.placeStill("cl_still", 0)]);
  const floor = await cut.version();
  assert.ok(floor < EDITOR_TEXT_SCHEMA_VERSION);
  const journal = () => readFile(join(cut.dir, "changes.jsonl"), "utf8");
  const before = { timeline: await cut.raw(), meta: await cut.worldBytes(), journal: await journal() };
  const refusedAs = (reason: string) => (error: unknown) => error instanceof TimelineCommandRefused && error.reason === reason;
  // A look from a later build, with a field this one does not know: the record's own strict read refuses it (R-26).
  const later = { ...LOOK, glow: { radius: 0.2 } };
  const refusals: Array<[string, TimelineClip, (error: unknown) => boolean]> = [
    ["words past the bound", textClip("cl_long", 96, "x".repeat(501)), refusedAs("Text holds at most 500 characters")],
    ["a look this build cannot read", textClip("cl_later", 96, "Ife", later), (error: unknown) => error instanceof Error && /glow/.test(error.message)],
    ["a gain on words", { ...textClip("cl_loud", 96), gainDb: -3 }, refusedAs("Text has no gain")],
    ["a character the face does not draw", textClip("cl_undrawn", 96, "漢"), refusedAs("Geist has no 漢")],
  ];
  for (const [what, clip, refused] of refusals) {
    await assert.rejects(cut.send([{ kind: "place", trackId: "tr_picture", clip }]), refused, what);
    assert.equal(await cut.raw(), before.timeline, what);
    assert.equal(await cut.worldBytes(), before.meta, what);
    assert.equal(await journal(), before.journal, `${what}: no line, the world's least of all`);
    assert.equal(await cut.version(), floor, what);
  }
});

test("a request file that holds a text place raises the world when it is written", async () => {
  const cut = await world();
  await cut.send([cut.placeStill("cl_still", 0)]);
  const before = await cut.raw();
  assert.ok(await cut.version() < EDITOR_TEXT_SCHEMA_VERSION);
  // Staged, not applied: the cut holds no text and the pending request does, which R-27 names too.
  const [staged] = await stageEditorRequests(cut.store, { conversationId: "cv_01J8G0000000000000000000C1", entryContext: { kind: "production", productionId: PRODUCTION },
    requests: [{ summary: "Add a name", commands: [{ kind: "place", trackId: "tr_picture", clip: textClip("cl_name", 96) }] }], now: NOW });
  assert.equal(staged?.status, "pending");
  assert.equal(await cut.raw(), before);
  assert.equal(carriesEditorText(before), false);
  assert.equal(carriesEditorText(await readFile(join(cut.dir, relativeRequests), "utf8")), true);
  assert.equal(await cut.version(), EDITOR_TEXT_SCHEMA_VERSION);
  const lines = await cut.changes();
  const raised = lines.find(line => line.entity === "world" && line.toVersion === EDITOR_TEXT_SCHEMA_VERSION);
  assert.ok(raised);
  assert.equal(lines.filter(line => line.path === relativeRequests).at(-1)?.commitId, raised.commitId, "the request file and the floor land together");
  await assert.rejects(readWorldMeta(cut.dir, { supports: EDITOR_TEXT_SCHEMA_VERSION - 1 }), /newer Arke Studio/);

  // Whatever the request layer lets through, the fence is the funnel's: a request file no staging
  // wrote, holding a text-set as staging now may (SPEC-065 R-35), raises the world all the same.
  const other = await world();
  assert.ok(await other.version() < EDITOR_TEXT_SCHEMA_VERSION);
  await other.store.commit({ kind: "adopt-editor-requests", source: "test", files: [{ path: relativeRequests, action: "create",
    content: requestBytes([{ kind: "text-set", clipIds: ["cl_name"], text: "Ife" }]), baseHash: null }] });
  assert.equal(await other.version(), EDITOR_TEXT_SCHEMA_VERSION);
});

test("a timeline with no text writes the bytes and the floor it wrote before", async () => {
  // SPEC-065 R-40, to the byte. Recorded from the code before text existed (ab20ec920), on the
  // same fixture world, clock and four writes. A number that moves here means a default or a
  // stamp on an existing record moved, and every legacy write with it: find out why before
  // recording it again.
  const { dir, raw, version, changes } = await legacy();
  const bytes = await raw();
  assert.equal(carriesEditorText(bytes), false);
  assert.equal(Buffer.byteLength(bytes), 4253);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "84608ae9b81b1ab766c3cfb040bb08c11e843da4699c704699940a981d5ef8e3");
  assert.equal(`${JSON.stringify(ProductionTimelineSchema.parse(JSON.parse(bytes)), null, 2)}\n`, bytes, "the record reads back to the bytes it was written as");
  // The place stamps the still's visual origin, which is the appearance floor's, and no write raises past it.
  assert.equal(await version(), EDITOR_APPEARANCE_SCHEMA_VERSION);
  const raised = (await changes()).filter(line => line.entity === "world").map(line => line.toVersion ?? 0);
  assert.equal(Math.max(...raised), EDITOR_APPEARANCE_SCHEMA_VERSION);
  await assert.rejects(stat(join(dir, TEXT_PICTURE_DIR)), "nothing is kept for a cut with no text");
});
