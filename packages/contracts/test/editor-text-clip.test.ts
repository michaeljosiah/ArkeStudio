import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTextSetCommand, applyTimelineCommands, ArtifactSidecarSchema, canonicalJson, describeTimelineCommand, detachAudioCommands, patchTextLook, ProductionTimelineSchema, redoTimelineHistory, resolvePictureTimeline,
  textLabel, TextLookPatchSchema, textPicturePath, textSetProblem, TextSetCommandSchema, TEXT_SET_MAX_CLIPS, TimelineCommandSchema, undoTimelineHistory,
  type ArtifactSidecar, type ProductionBundle, type ProductionTimeline, type TextLook, type TimelineClip, type TimelineClipCommand, type TimelineCommand } from "../src/index.js";

/**
 * A text clip as the record holds it (SPEC-065 slice 2): where it may sit and what it may carry
 * (R-2), the words as a write stores them (R-4, R-6), their bounds on every payload that carries
 * them (R-26), `text-set` (R-25), the edits a still takes (R-14), Undo (R-28), and the two
 * refusals that hold until text is painted for a move or a crossfade (R-17).
 */

const AT = "2026-11-12T10:00:00Z";
const STILL_A = "ar_01J8E0000000000000000000A1", STILL_B = "ar_01J8E0000000000000000000A2", FILM = "ar_01J8E0000000000000000000A3", SONG = "ar_01J8E0000000000000000000A4";
const sidecar = (id: string, kind: "image" | "video" | "audio", file: string): ArtifactSidecar => ArtifactSidecarSchema.parse({
  id, kind, file, hash: `sha256:${"a".repeat(64)}`, origin: { by: "system", producedBy: "accepted-still" }, links: [], created: AT });
const artifacts = [sidecar(STILL_A, "image", "a.png"), sidecar(STILL_B, "image", "b.png"), sidecar(FILM, "video", "film.mp4"), sidecar(SONG, "audio", "song.mp3")];
const production = (): ProductionBundle => ({
  rehearsals: [], performances: [], performanceReview: { reviews: [], selections: {}, reviewHash: null, selectionHash: null },
  meta: { id: "the-names", format: "video", medium: "video", kind: "microdrama", title: "The Names", status: "in-progress", frameRate: 24, failureModes: [], created: AT, updated: AT },
  story: null, season: null, routing: null, treatment: null, chapters: [], scenes: [], sceneFiles: {}, episodes: [], episodeFiles: {},
  takes: [], reviews: [], selections: {}, spine: null, cut: { audio: [], overlays: [] }, editorRequests: [], takeMediaInfo: {},
});
const sources = { production: production(), artifacts };

const look = (): TextLook => ({ typeface: "geist", weight: "regular", italic: false, size: 0.08, tracking: 0, leading: 1.2, capitals: false, align: "center",
  x: 0.5, y: 0.5, room: 0.8, fill: { kind: "solid", color: "#ffffff" } });
const textClip = (id: `cl_${string}`, startFrame: number, text: string, extra: Partial<TimelineClip> = {}): TimelineClip => ({
  id, startFrame, durationFrames: 112, sourceInFrames: 0, source: { kind: "text", label: textLabel(text), text, look: look() }, fade: { inFrames: 24, outFrames: 30 }, ...extra });
const still = (id: `cl_${string}`, startFrame: number, durationFrames: number, artifactId: string, label: string): TimelineClip => ({
  id, startFrame, durationFrames, sourceInFrames: 0, source: { kind: "artifact", artifactId, label } });

/** Two stills and a film below, the names above, a song, and the tracks text may never sit on. */
const raw = (names: TimelineClip[] = [textClip("cl_ade", 0, "Ade"), textClip("cl_ife", 200, "Ife\nthe healer")]) => JSON.parse(JSON.stringify({
  schemaVersion: 1, revision: 0, frameRate: 24, tracks: [
    { id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: [
      still("cl_a", 0, 72, STILL_A, "A"), still("cl_b", 72, 72, STILL_B, "B"), still("cl_film", 168, 48, FILM, "Film")] },
    { id: "tr_names", kind: "picture", name: "Names", order: 1, muted: false, clips: names },
    { id: "tr_music", kind: "music", name: "Music", order: 2, muted: false, clips: [{ ...still("cl_song", 0, 216, SONG, "Song"), role: "music" }] },
    { id: "tr_subs", kind: "subtitle", name: "Subtitles", order: 3, muted: false, language: "en", cues: [], clips: [] },
    { id: "tr_fx", kind: "effect", name: "Effects", order: 4, muted: false, clips: [], effects: [] },
  ], history: { undo: [], redo: [] } }));
const timeline = (names?: TimelineClip[]): ProductionTimeline => ProductionTimelineSchema.parse(raw(names));
const apply = (base: ProductionTimeline, commands: TimelineClipCommand[]) => applyTimelineCommands(base, commands, { sources, effectAuthority: "human" });
// As a request's preview runs it: no sources, so no still test at all.
const applyBare = (base: ProductionTimeline, commands: TimelineClipCommand[]) => applyTimelineCommands(base, commands, { effectAuthority: "human" });
const clip = (value: ProductionTimeline, id: string) => value.tracks.flatMap(track => track.clips).find(row => row.id === id)!;
const source = (value: ProductionTimeline, id: string) => { const found = clip(value, id).source; assert.equal(found.kind, "text"); return found; };
/** A refusal by name: the reducer's own error with exactly these words, never a ZodError. */
const refused = (run: () => unknown, message: string) => assert.throws(run, { name: "TimelineOperationRefused", message });
const issues = (value: unknown) => { const read = ProductionTimelineSchema.safeParse(value); assert.equal(read.success, false); return read.error!.issues.map(issue => issue.message).join(" | "); };
const place = (trackId: `tr_${string}`, value: TimelineClip): TimelineClipCommand => ({ kind: "place", trackId, clip: value });
const push = { kind: "push-in", amount: .08 } as const;

test("a text source on an audio, a subtitle or an effect track refuses, as a record and as a place", () => {
  for (const index of [2, 3, 4]) {
    const value = raw();
    value.tracks[index].clips.push(textClip("cl_wrong", 400, "Ade"));
    assert.match(issues(value), /Text belongs on a Picture track/);
  }
  for (const trackId of ["tr_music", "tr_subs", "tr_fx"] as const) refused(() => apply(timeline(), [place(trackId, textClip("cl_new", 400, "Ade"))]), "Text belongs on a Picture track");
});

test("a text clip with a source in-point, a gain, an audio choice, a role or a link refuses, live and in Undo", () => {
  const carried: Array<[Partial<TimelineClip>, string]> = [
    [{ sourceInFrames: 4 }, "Text has no source in-point"], [{ gainDb: -3 }, "Text has no gain"], [{ audio: "keep" }, "Text has no sound"],
    [{ role: "music" }, "Text has no sound"], [{ linkedClipId: "cl_song" }, "Text has no linked clip"], [{ performanceSourceClipId: "cl_song" }, "Text has no sound"],
  ];
  const changed = apply(timeline(), [{ kind: "text-set", clipIds: ["cl_ade"], look: { size: 0.1 } }]);
  for (const [extra, message] of carried) {
    refused(() => apply(timeline(), [place("tr_names", textClip("cl_new", 400, "Kemi", extra))]), message);
    assert.match(issues(raw([textClip("cl_ade", 0, "Ade", extra)])), new RegExp(message));
    // The same clip in a history entry: Undo would put it back, so the record does not read.
    const saved = JSON.parse(JSON.stringify(changed));
    Object.assign(saved.history.undo[0].clips[0].before, extra);
    assert.match(issues(saved), new RegExp(message));
  }
  for (const audio of ["keep", "mute"] as const) refused(() => apply(timeline(), [{ kind: "set-clip-audio", clipId: "cl_ade", audio }]), "Text has no sound");
});

test("501 characters, 13 lines, only blank lines, an unknown field and a value outside its range each refuse, and nothing is clamped", () => {
  const words: Array<[string, string]> = [["a".repeat(501), "Text holds at most 500 characters"], [Array(13).fill("a").join("\n"), "Text holds at most 12 lines"], ["  \n\n \n", "Type some words"]];
  const withSource = (patch: Record<string, unknown>) => ({ ...textClip("cl_new", 400, "Kemi"), source: { ...textClip("cl_new", 400, "Kemi").source, ...patch } });
  const broken = [...words.map(([text]) => withSource({ text, label: "a" })), withSource({ font: "serif" }), withSource({ look: { ...look(), size: 0.5 } })];
  const changed = JSON.parse(JSON.stringify(apply(timeline(), [{ kind: "text-set", clipIds: ["cl_ade"], look: { size: 0.1 } }])));
  for (const value of broken) {
    assert.equal(ProductionTimelineSchema.safeParse(raw([value])).success, false, "the record");
    assert.equal(TimelineCommandSchema.safeParse({ kind: "place", trackId: "tr_names", clip: value }).success, false, "a place");
    const history = JSON.parse(JSON.stringify(changed));
    history.history.undo[0].clips[0].after = { ...value, id: "cl_ade", startFrame: 0 };
    assert.equal(ProductionTimelineSchema.safeParse(history).success, false, "a history entry");
  }
  for (const [text, message] of words) {
    assert.match(issues(raw([withSource({ text, label: "a" })])), new RegExp(message));
    const read = TimelineCommandSchema.safeParse({ kind: "text-set", clipIds: ["cl_ade"], text });
    assert.equal(read.success, false); assert.match(read.error!.issues.map(issue => issue.message).join(" "), new RegExp(message));
  }
  assert.equal(TimelineCommandSchema.safeParse({ kind: "text-set", clipIds: ["cl_ade"], look: { font: "serif" } }).success, false);
  assert.equal(TimelineCommandSchema.safeParse({ kind: "text-set", clipIds: ["cl_ade"], look: { size: 0.5 } }).success, false);
  assert.equal(TimelineCommandSchema.safeParse({ kind: "text-set", clipIds: ["cl_ade"], text: "Ade", font: "serif" }).success, false);
  // At the bounds everything is kept as typed; past them nothing is cut to fit. Blank lines after
  // the last words are not counted, because a write does not keep them (R-4).
  const full = apply(timeline(), [{ kind: "text-set", clipIds: ["cl_ade"], text: `${"a".repeat(500)}\n\n` }]);
  assert.equal(source(full, "cl_ade").text, "a".repeat(500));
  const twelve = Array.from({ length: 12 }, (_, line) => `line ${line + 1}`).join("\n");
  assert.equal(source(apply(timeline(), [place("tr_names", textClip("cl_new", 400, twelve))]), "cl_new").text, twelve);
});

test("a place handed in-process with a field text does not have refuses, as over the socket (R-26)", () => {
  // A typed caller skips the command's schema; the stored words are rebuilt, and the field must not vanish with the rebuild.
  const sent = textClip("cl_new", 400, "Kemi");
  const runs = { ...sent, source: { ...sent.source, runs: [] } };
  assert.throws(() => apply(timeline(), [place("tr_names", runs)]), /runs/);
  assert.equal(TimelineCommandSchema.safeParse({ kind: "place", trackId: "tr_names", clip: runs }).success, false);
});

test("a place with a blank line above and below stores the words without them", () => {
  const typed = { ...textClip("cl_new", 400, "Kemi"), source: { kind: "text" as const, label: "Kemi", text: "\n  \nKemi\nthe smith\n\n", look: look() } };
  const placed = apply(timeline(), [place("tr_names", typed)]);
  assert.deepEqual(source(placed, "cl_new"), { kind: "text", label: "Kemi", text: "Kemi\nthe smith", look: look() });
  assert.equal(ProductionTimelineSchema.safeParse(JSON.parse(JSON.stringify(placed))).success, true, "what was stored reads back");
});

test("a place typed with Windows line ends stores one picture name", () => {
  const typed = (text: string, id: `cl_${string}`) => ({ ...textClip(id, 400, "Kemi"), source: { kind: "text" as const, label: "Kemi", text, look: look() } });
  const windows = source(apply(timeline(), [place("tr_names", typed("Kemi\r\nthe smith\r\n", "cl_w"))]), "cl_w");
  const plain = source(apply(timeline(), [place("tr_names", typed("Kemi\nthe smith", "cl_p"))]), "cl_p");
  assert.equal(windows.text, "Kemi\nthe smith");
  assert.deepEqual(textPicturePath(windows, { width: 1920, height: 1080 }), textPicturePath(plain, { width: 1920, height: 1080 }));
});

test("a place's label is the first line whatever label was sent (R-6)", () => {
  const sent = { ...textClip("cl_new", 400, "Kemi"), source: { kind: "text" as const, label: "Something else", text: "\nKemi\nthe smith", look: look() } };
  assert.equal(source(apply(timeline(), [place("tr_names", sent)]), "cl_new").label, "Kemi");
  assert.equal(describeTimelineCommand({ kind: "place", trackId: "tr_names", clip: sent }), "Place Kemi on tr_names");
  // Words that will be refused keep the label they were sent with: the line is about to go anyway.
  assert.equal(describeTimelineCommand({ kind: "place", trackId: "tr_names", clip: { ...sent, source: { ...sent.source, text: " \n " } } }), "Place Something else on tr_names");
});

test("a label that is not the first line refuses, and text-set writes the first line as the label", () => {
  assert.match(issues(raw([{ ...textClip("cl_ade", 0, "Ade"), source: { kind: "text", label: "Someone", text: "Ade", look: look() } }])), /A text clip's label is its first line/);
  const set = apply(timeline(), [{ kind: "text-set", clipIds: ["cl_ife"], text: "Kemi\nthe smith" }]);
  assert.equal(source(set, "cl_ife").label, "Kemi");
});

test("text-set derives the label and drops outer blank lines", () => {
  const set = apply(timeline(), [{ kind: "text-set", clipIds: ["cl_ade"], text: "\n \nKemi\r\nthe smith\n\n" }]);
  assert.deepEqual(source(set, "cl_ade"), { kind: "text", label: "Kemi", text: "Kemi\nthe smith", look: look() });
  const entry = set.history.undo.at(-1)!;
  assert.ok(entry.kind === "change");
  assert.equal(entry.label, "Change text");
});

test("a record whose stored words keep an outer blank line or a carriage return does not read", () => {
  for (const text of ["Ade\n", "\nAde", "Ade\r\nthe healer", "  \nAde"]) {
    assert.match(issues(raw([{ ...textClip("cl_ade", 0, "Ade"), source: { kind: "text", label: "Ade", text, look: look() } }])),
      /Stored text has a blank first or last line, or a carriage return/, JSON.stringify(text));
  }
});

test("text-set on fifty clips is one revision and one Undo, and fifty-one refuses", () => {
  const names = Array.from({ length: TEXT_SET_MAX_CLIPS + 1 }, (_, index) => textClip(`cl_n${index}`, index * 120, `Name ${index}`));
  const base = timeline(names);
  const ids = names.slice(0, TEXT_SET_MAX_CLIPS).map(value => value.id);
  const set = apply(base, [{ kind: "text-set", clipIds: ids, look: { size: 0.1, edge: { color: "#000000", width: 0.02 } } }]);
  assert.equal(set.revision, base.revision + 1);
  assert.equal(set.history.undo.length, 1);
  const entry = set.history.undo[0]!;
  assert.ok(entry.kind === "change");
  assert.equal(entry.clips.length, TEXT_SET_MAX_CLIPS, "the fifty-first clip is not in the entry");
  assert.equal(entry.label, `Change text on ${TEXT_SET_MAX_CLIPS} clips`);
  for (const id of ids) assert.equal(source(set, id).look.size, 0.1);
  assert.equal(source(set, `cl_n${TEXT_SET_MAX_CLIPS}`).look.size, 0.08);
  const undone = undoTimelineHistory(set);
  for (const id of ids) assert.deepEqual(source(undone, id), source(base, id));
  const all = { kind: "text-set", clipIds: names.map(value => value.id), look: { size: 0.1 } };
  assert.equal(TextSetCommandSchema.safeParse(all).success, false);
  assert.equal(TimelineCommandSchema.safeParse(all).success, false);
});

test("text-set on a batch holding one picture clip changes nothing", () => {
  const base = timeline(), before = JSON.stringify(base);
  refused(() => apply(base, [{ kind: "text-set", clipIds: ["cl_ade", "cl_a"], look: { size: 0.1 } }]), "cl_a is not text");
  assert.throws(() => applyTextSetCommand(base.tracks, { kind: "text-set", clipIds: ["cl_ade", "cl_a"], look: { size: 0.1 } }), { message: "cl_a is not text" });
  refused(() => apply(base, [{ kind: "text-set", clipIds: ["cl_ade", "cl_gone"], look: { size: 0.1 } }]), "timeline does not contain cl_gone");
  assert.equal(JSON.stringify(base), before, "no clip was touched on the way to the refusal");
});

test("text-set with the values already held writes no revision", () => {
  const base = timeline();
  assert.throws(() => apply(base, [{ kind: "text-set", clipIds: ["cl_ade", "cl_ife"], look: { size: 0.08, align: "center" } }]), /changes nothing/);
  assert.throws(() => apply(base, [{ kind: "text-set", clipIds: ["cl_ife"], text: "Ife\nthe healer", look: { typeface: "geist" } }]), /changes nothing/);
  // The look is compared once it is the look: a part removed that was never there is no change.
  assert.throws(() => apply(base, [{ kind: "text-set", clipIds: ["cl_ade"], look: { edge: null } }]), /changes nothing/);
  assert.equal(applyTextSetCommand(base.tracks, { kind: "text-set", clipIds: ["cl_ade"], look: { size: 0.08 } })[1], base.tracks[1], "the track keeps its identity");
});

test("text-set with the held words and a trailing newline writes no revision", () => {
  assert.throws(() => apply(timeline(), [{ kind: "text-set", clipIds: ["cl_ife"], text: "Ife\r\nthe healer\n" }]), /changes nothing/);
});

test("a look patch keeps what it leaves out, null removes an edge, a shadow, a rule and a backing, and words need one clip", () => {
  const dressed = patchTextLook(look(), { size: 0.12, edge: { color: "#000000", width: 0.02 }, shadow: { color: "#000000", opacity: 0.5, blur: 0.1, dx: 0, dy: 0.05 },
    rule: { length: 0.3, weight: 0.01, gap: 0.5, soft: true }, backing: { kind: "shade", color: "#000000", opacity: 0.4 } });
  assert.deepEqual({ ...dressed, size: 0.08, edge: undefined, shadow: undefined, rule: undefined, backing: undefined }, { ...look(), edge: undefined, shadow: undefined, rule: undefined, backing: undefined });
  assert.equal(dressed.size, 0.12);
  const bare = patchTextLook(dressed, { edge: null, shadow: null, rule: null, backing: null });
  for (const part of ["edge", "shadow", "rule", "backing"]) assert.equal(part in bare, false, part);
  assert.deepEqual(bare, { ...look(), size: 0.12 });
  // A part is replaced whole: a new edge does not keep the old one's width.
  assert.equal(TextLookPatchSchema.safeParse({ edge: { color: "#ff0000" } }).success, false);
  assert.equal(TextLookPatchSchema.safeParse({ fill: null }).success, false, "only a part that may be absent can be removed");
  assert.equal(textSetProblem({ kind: "text-set", clipIds: ["cl_ade", "cl_ade"], look: { size: 0.1 } }), "Name each text clip once");
  assert.equal(textSetProblem({ kind: "text-set", clipIds: ["cl_ade"] }), "Choose words or a look to change");
  assert.equal(textSetProblem({ kind: "text-set", clipIds: ["cl_ade", "cl_ife"], text: "Kemi" }), "Words are set on one text clip at a time");
  refused(() => apply(timeline(), [{ kind: "text-set", clipIds: ["cl_ade", "cl_ife"], text: "Kemi" }]), "Words are set on one text clip at a time");
  refused(() => apply(timeline(), [{ kind: "text-set", clipIds: ["cl_ade"] }]), "Choose words or a look to change");
  const removed = apply(apply(timeline(), [{ kind: "text-set", clipIds: ["cl_ade"], look: { edge: { color: "#000000", width: 0.02 } } }]), [{ kind: "text-set", clipIds: ["cl_ade"], look: { edge: null } }]);
  assert.equal("edge" in source(removed, "cl_ade").look, false);
  assert.equal(describeTimelineCommand({ kind: "text-set", clipIds: ["cl_ade"], look: { size: 0.1 } }), "Change text");
});

test("a text clip placed on a track added in the same batch is one revision and one Undo", () => {
  const base = timeline();
  const both = apply(base, [{ kind: "add-track", trackId: "tr_titles", trackKind: "picture", name: "Titles" }, place("tr_titles", textClip("cl_title", 24, "The Names"))]);
  assert.equal(both.revision, base.revision + 1);
  assert.equal(both.history.undo.length, 1);
  assert.equal(source(both, "cl_title").text, "The Names");
  const undone = undoTimelineHistory(ProductionTimelineSchema.parse(JSON.parse(JSON.stringify(both))));
  assert.equal(undone.tracks.some(track => track.id === "tr_titles"), false);
  assert.deepEqual(source(redoTimelineHistory(undone), "cl_title"), source(both, "cl_title"));
});

test("a split text clip keeps its words and look on both halves, and each fade at its outer edge", () => {
  const cut = apply(timeline(), [{ kind: "split", clipId: "cl_ife", atFrame: 260, newClipId: "cl_ife2" }]);
  const left = clip(cut, "cl_ife"), right = clip(cut, "cl_ife2");
  assert.deepEqual(left.source, clip(timeline(), "cl_ife").source);
  assert.deepEqual(right.source, left.source);
  assert.deepEqual(left.fade, { inFrames: 24 }); assert.deepEqual(right.fade, { outFrames: 30 });
  assert.equal(left.sourceInFrames, 0); assert.equal(right.sourceInFrames, 0);
  assert.deepEqual([left.startFrame, left.durationFrames, right.startFrame, right.durationFrames], [200, 60, 260, 52]);
});

test("a text clip trims at both edges, moves, duplicates and deletes, and its in-point stays at zero", () => {
  let current = apply(timeline(), [{ kind: "trim", clipId: "cl_ade", edge: "end", deltaFrames: 40 }]);
  assert.equal(clip(current, "cl_ade").durationFrames, 152, "no source length bounds text's tail");
  current = apply(current, [{ kind: "trim", clipId: "cl_ade", edge: "start", deltaFrames: 12 }]);
  assert.deepEqual([clip(current, "cl_ade").startFrame, clip(current, "cl_ade").durationFrames, clip(current, "cl_ade").sourceInFrames], [12, 140, 0]);
  current = apply(current, [{ kind: "move-to-frame", clipId: "cl_ade", startFrame: 40 }]);
  assert.equal(clip(current, "cl_ade").startFrame, 40);
  assert.deepEqual(source(current, "cl_ade"), source(timeline(), "cl_ade"));
});

test("a text clip's head trimmed later keeps in-point 0 and its words", () => {
  const later = apply(timeline(), [{ kind: "trim", clipId: "cl_ife", edge: "start", deltaFrames: 30 }]);
  assert.equal(clip(later, "cl_ife").sourceInFrames, 0);
  assert.deepEqual(source(later, "cl_ife"), source(timeline(), "cl_ife"));
  // As a still at its first frame: the head never extends earlier, and Undo is how it comes back (R-14).
  refused(() => apply(later, [{ kind: "trim", clipId: "cl_ife", edge: "start", deltaFrames: -10 }]), "cl_ife has no source before its first frame");
  refused(() => apply(timeline(), [{ kind: "trim", clipId: "cl_ife", edge: "start", deltaFrames: -10 }]), "cl_ife has no source before its first frame");
  assert.equal(clip(undoTimelineHistory(later), "cl_ife").startFrame, 200);
});

test("a text clip moves, duplicates and deletes as a still does, and the copy keeps its words and look (R-14)", () => {
  const copied = apply(timeline(), [{ kind: "duplicate", clipId: "cl_ife", newClipId: "cl_ife2" }]);
  const copy = clip(copied, "cl_ife2");
  assert.deepEqual(copy.source, clip(copied, "cl_ife").source);
  assert.deepEqual(copy.fade, clip(copied, "cl_ife").fade);
  assert.equal(copy.startFrame, 312);
  const moved = apply(timeline(), [{ kind: "move-adjacent", clipId: "cl_ade", direction: "later" }]);
  assert.ok(clip(moved, "cl_ade").startFrame > clip(moved, "cl_ife").startFrame);
  const gone = apply(timeline(), [{ kind: "delete", clipId: "cl_ade" }]);
  assert.equal(gone.tracks[1]!.clips.some(row => row.id === "cl_ade"), false);
  assert.deepEqual(source(undoTimelineHistory(gone), "cl_ade"), source(timeline(), "cl_ade"));
});

test("ripple delete closes over a text clip as over a still", () => {
  const asText = apply(timeline(), [{ kind: "ripple-delete", clipId: "cl_ade" }]);
  const asStill = apply(timeline([still("cl_ade", 0, 112, STILL_A, "A"), textClip("cl_ife", 200, "Ife\nthe healer")]), [{ kind: "ripple-delete", clipId: "cl_ade" }]);
  assert.equal(clip(asText, "cl_ife").startFrame, clip(asStill, "cl_ife").startFrame);
  assert.equal(clip(asText, "cl_ife").startFrame, 88);
});

test("Undo restores the words and the look exactly, through a saved record", () => {
  const base = timeline();
  const set = apply(base, [{ kind: "text-set", clipIds: ["cl_ife"], text: "Kemi", look: { weight: "regular", align: "left", backing: { kind: "box", color: "#102030", opacity: 0.5 } } }]);
  const saved = ProductionTimelineSchema.parse(JSON.parse(JSON.stringify(set)));
  const undone = undoTimelineHistory(saved);
  assert.deepEqual(source(undone, "cl_ife"), source(base, "cl_ife"));
  assert.equal("backing" in source(undone, "cl_ife").look, false);
  const redone = redoTimelineHistory(ProductionTimelineSchema.parse(JSON.parse(JSON.stringify(undone))));
  assert.deepEqual(source(redone, "cl_ife"), source(set, "cl_ife"));
});

test("text does not move or crossfade yet, and says so", () => {
  // Two names touching on their track, and a name between a still and the film on the base track.
  const base = apply(timeline(), [place("tr_names", { ...textClip("cl_kemi", 112, "Kemi"), durationFrames: 88 }), place("tr_picture", { ...textClip("cl_mid", 144, "Mid"), durationFrames: 24 })]);
  for (const run of [apply, applyBare]) {
    refused(() => run(base, [{ kind: "picture-motion", clipId: "cl_ade", motion: push }]), "Text does not move yet");
    refused(() => run(base, [place("tr_names", textClip("cl_new", 400, "Kemi", { motion: push }))]), "Text does not move yet");
    refused(() => run(base, [{ kind: "transition-set", trackId: "tr_names", leftClipId: "cl_ade", rightClipId: "cl_kemi", durationFrames: 12 }]), "Text does not crossfade yet");
    refused(() => run(base, [{ kind: "transition-set", trackId: "tr_picture", leftClipId: "cl_b", rightClipId: "cl_mid", durationFrames: 12 }]), "Text does not crossfade yet");
    assert.throws(() => run(base, [{ kind: "picture-motion", clipId: "cl_ade", motion: null }]), /changes nothing/);
  }
  // A fade rides text as it rides a still (R-15).
  assert.deepEqual(clip(apply(base, [{ kind: "picture-fade", clipId: "cl_ade", inFrames: 12 }]), "cl_ade").fade, { inFrames: 12, outFrames: 30 });
});

test("a text clip has no sound to keep, mute or detach", () => {
  for (const audio of ["keep", "mute"] as const) refused(() => apply(timeline(), [{ kind: "set-clip-audio", clipId: "cl_ade", audio }]), "Text has no sound");
  refused(() => detachAudioCommands(production(), timeline(), artifacts, "cl_ade", "cl_sound"), "Text has no sound");
  refused(() => apply(timeline(), [{ kind: "set-clip-gain", clipId: "cl_ade", gainDb: -3 }]), "cl_ade is on a picture track, which has no gain");
});

test("a text clip on the base Picture track is not a gap", () => {
  const base = apply(timeline(), [place("tr_picture", { ...textClip("cl_mid", 144, "Mid"), durationFrames: 24 })]);
  const resolved = resolvePictureTimeline(production(), { status: "ready", timeline: base }, artifacts);
  const entry = resolved.entries.find(row => row.clipId === "cl_mid")!;
  assert.equal(entry.text, true);
  assert.equal(entry.media, null);
  assert.equal(entry.label, "Mid");
  assert.equal(resolved.gaps, 0);
  assert.equal(resolved.entries.filter(row => row.text === true).length, 1, "only the text clip is marked");
});

test("a timeline with no text reads and writes as it did", () => {
  const plain = raw([still("cl_name", 0, 112, STILL_B, "Name")]);
  const read = ProductionTimelineSchema.parse(plain);
  // Every default a read adds is already in the record a write stores, so the second read is the first.
  assert.equal(canonicalJson(ProductionTimelineSchema.parse(JSON.parse(JSON.stringify(read)))), canonicalJson(read));
  const edited = apply(read, [{ kind: "trim", clipId: "cl_name", edge: "start", deltaFrames: 12 }, { kind: "split", clipId: "cl_film", atFrame: 192, newClipId: "cl_film2" }]);
  assert.equal(clip(edited, "cl_name").sourceInFrames, 12, "a still's head trim still advances its in-point");
  assert.equal(clip(edited, "cl_film2").sourceInFrames, 24, "a film's right half still starts partway in");
  assert.equal(canonicalJson(ProductionTimelineSchema.parse(JSON.parse(JSON.stringify(edited)))), canonicalJson(edited));
  const commands: Array<[TimelineCommand, string]> = [
    [{ kind: "move-adjacent", clipId: "cl_a", direction: "later" }, "Move cl_a later"],
    [{ kind: "move-to-order", clipId: "cl_a", index: 1 }, "Move cl_a to position 2"],
    [{ kind: "move-to-frame", clipId: "cl_a", startFrame: 24 }, "Move cl_a to frame 24"],
    [{ kind: "trim", clipId: "cl_a", edge: "start", deltaFrames: -4 }, "Trim the start of cl_a by -4 frames"],
    [{ kind: "split", clipId: "cl_a", atFrame: 30, newClipId: "cl_a2" }, "Split cl_a at frame 30"],
    [{ kind: "duplicate", clipId: "cl_a", newClipId: "cl_a2" }, "Duplicate cl_a"],
    [{ kind: "delete", clipId: "cl_a" }, "Delete cl_a"],
    [{ kind: "ripple-delete", clipId: "cl_a" }, "Ripple delete cl_a"],
    [{ kind: "place", trackId: "tr_picture", clip: still("cl_c", 300, 24, STILL_A, "A still") }, "Place A still on tr_picture"],
    [{ kind: "set-clip-gain", clipId: "cl_song", gainDb: -6 }, "Set cl_song to -6 dB"],
    [{ kind: "set-clip-audio", clipId: "cl_film", audio: "mute" }, "Mute picture sound"],
    [{ kind: "detach-audio", clipId: "cl_film", newClipId: "cl_film_sound" }, "Detach audio"],
    [{ kind: "picture-fade", clipId: "cl_a", inFrames: 12 }, "Set picture fade"],
    [{ kind: "picture-motion", clipId: "cl_a", motion: push }, "Set picture motion"],
    [{ kind: "transition-set", trackId: "tr_picture", leftClipId: "cl_a", rightClipId: "cl_b", durationFrames: 12 }, "Set crossfade to 12 frames"],
    [{ kind: "add-track", trackId: "tr_more", trackKind: "picture", name: "More" }, "Add picture track More"],
    [{ kind: "set-mix", mix: { duckingDb: -6 } }, "Change the mix"],
  ];
  for (const [command, said] of commands) assert.equal(describeTimelineCommand(command), said);
});
