import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  ProductionTimelineSchema, TEXT_ADD_FADE_SECONDS, TEXT_ADD_SECONDS, TEXT_ADD_WORDS, TEXT_DEFAULT_LOOK, TEXT_LOOK_BOUNDS, TEXT_PART_DEFAULTS,
  TEXT_TYPEFACE_IDS, TextLookPatchSchema, TextLookSchema, applyTimelineCommands, patchTextLook, textAddCommands, textLabel, textLookForNewClip,
  textTypefaceFile, textTypefacePatch, undoTimelineHistory,
  type ProductionTimeline, type TextLook, type TimelineClip, type TimelineClipCommand,
} from "../src/index.js";

/**
 * The Cut's Add text as the record sees it (SPEC-065 R-29, R-30; turn 277 rules 2, 6, 7 and 8):
 * one batch, one revision, on the highest Picture track with the whole four seconds free, in the
 * look of the title last placed or styled, and the helpers the Inspector reads its choices from.
 */

const STILL = "ar_01J8E0000000000000000000A1";
const still = (id: `cl_${string}`, startFrame: number, durationFrames: number): TimelineClip =>
  ({ id, startFrame, durationFrames, sourceInFrames: 0, source: { kind: "artifact", artifactId: STILL, label: "Still" } });
const looked = (change: Partial<TextLook>): TextLook => ({ ...TEXT_DEFAULT_LOOK, ...change });
const title = (id: `cl_${string}`, startFrame: number, words: string, look: TextLook): TimelineClip =>
  ({ id, startFrame, durationFrames: 48, sourceInFrames: 0, source: { kind: "text", label: textLabel(words), text: words, look } });

/** A base track of pictures from 0 to 216, an empty Names track above it, and a song. */
function timeline(options: { names?: TimelineClip[]; base?: TimelineClip[]; frameRate?: 24 | 25 | 30; namesMuted?: boolean; extraTracks?: object[] } = {}): ProductionTimeline {
  return ProductionTimelineSchema.parse(JSON.parse(JSON.stringify({
    schemaVersion: 1, revision: 0, frameRate: options.frameRate ?? 24, tracks: [
      { id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: options.base ?? [still("cl_a", 0, 120), still("cl_b", 120, 96)] },
      { id: "tr_names", kind: "picture", name: "Names", order: 1, muted: options.namesMuted ?? false, clips: options.names ?? [] },
      { id: "tr_music", kind: "music", name: "Music", order: 2, muted: false, clips: [] },
      ...(options.extraTracks ?? []),
    ], history: { undo: [], redo: [] } })));
}
const apply = (base: ProductionTimeline, commands: readonly TimelineClipCommand[]) => applyTimelineCommands(base, commands, { effectAuthority: "human" });
const add = (base: ProductionTimeline, playheadFrame: number, clipId: `cl_${string}` = "cl_new") => textAddCommands(base, { playheadFrame, clipId });
const placed = (commands: readonly TimelineClipCommand[]) => {
  const place = commands.at(-1)!;
  assert.equal(place.kind, "place");
  return place;
};
const lookOf = (base: ProductionTimeline, id: string): TextLook => {
  const source = base.tracks.flatMap(track => track.clips).find(clip => clip.id === id)!.source;
  assert.equal(source.kind, "text");
  return source.look;
};

test("Add places \"Text\" for four seconds with half-second fades at the playhead, in one batch", () => {
  const base = timeline(), commands = add(base, 30);
  assert.deepEqual(commands, [{ kind: "place", trackId: "tr_names", clip: {
    id: "cl_new", startFrame: 30, durationFrames: 96, sourceInFrames: 0,
    source: { kind: "text", label: "Text", text: "Text", look: TEXT_DEFAULT_LOOK }, fade: { inFrames: 12, outFrames: 12 },
  } }]);
  assert.deepEqual([TEXT_ADD_WORDS, TEXT_ADD_SECONDS, TEXT_ADD_FADE_SECONDS], ["Text", 4, 0.5]);
  const after = apply(base, commands);
  assert.equal(after.revision, base.revision + 1, "one revision");
  assert.equal(after.history.undo.length, 1, "one Undo");
  assert.deepEqual(after.history.undo[0]!.kind === "change" && after.history.undo[0]!.clips.map(change => [change.before, change.after?.id]), [[null, "cl_new"]]);
  // The length and the fades are seconds, so they are the frame rate's.
  for (const [frameRate, length, fade] of [[25, 100, 13], [30, 120, 15]] as const) {
    const clip = placed(add(timeline({ frameRate }), 0));
    assert.ok(clip.kind === "place");
    assert.deepEqual([clip.clip.durationFrames, clip.clip.fade], [length, { inFrames: fade, outFrames: fade }], `${frameRate} fps`);
  }
  assert.throws(() => add(base, -1), RangeError);
  assert.throws(() => add(base, 1.5), RangeError);
});

test("Add takes the highest Picture track with room, the base track among them", () => {
  // Both free past the pictures: the higher one.
  assert.equal(placed(add(timeline(), 400)).trackId, "tr_names");
  // Names busy at the playhead, the base track free there: the base track.
  const busy = timeline({ names: [title("cl_held", 380, "Held", TEXT_DEFAULT_LOOK)] });
  const onBase = add(busy, 400);
  assert.equal(onBase.length, 1);
  assert.equal(placed(onBase).trackId, "tr_picture");
  assert.ok(apply(busy, onBase).tracks.find(track => track.id === "tr_picture")!.clips.some(clip => clip.id === "cl_new"));
  // A higher Picture track wins over Names, whatever the order the tracks are listed in.
  const over = timeline({ extraTracks: [{ id: "tr_overlay-1", kind: "picture", name: "Overlay 1", order: 3, muted: false, clips: [] }] });
  assert.equal(placed(add(over, 0)).trackId, "tr_overlay-1");
});

test("Add skips a hidden Picture track", () => {
  // Names is hidden: past the pictures the base track takes the title.
  assert.equal(placed(add(timeline({ namesMuted: true }), 400)).trackId, "tr_picture");
  // Hidden Names and a full base track: a new track, not the hidden one.
  const commands = add(timeline({ namesMuted: true }), 30);
  assert.equal(commands[0]!.kind, "add-track");
  assert.equal(placed(commands).trackId, "tr_overlay-1");
});

test("Add makes Overlay n above every track when no Picture track has room, in the same batch", () => {
  const base = timeline({ names: [title("cl_held", 0, "Held", TEXT_DEFAULT_LOOK)] }), commands = add(base, 30);
  assert.deepEqual(commands.map(command => command.kind), ["add-track", "place"]);
  assert.deepEqual(commands[0], { kind: "add-track", trackId: "tr_overlay-1", trackKind: "picture", name: "Overlay 1" });
  assert.equal(placed(commands).trackId, "tr_overlay-1");
  const after = apply(base, commands), made = after.tracks.find(track => track.id === "tr_overlay-1")!;
  assert.equal(made.order, Math.max(...base.tracks.map(track => track.order)) + 1, "above every track, the song's too");
  assert.deepEqual(made.clips.map(clip => clip.id), ["cl_new"]);
  assert.equal(after.revision, base.revision + 1, "the track and the clip are one revision");
  assert.equal(after.history.undo.length, 1, "and one Undo");
  assert.equal(undoTimelineHistory(after).tracks.some(track => track.id === "tr_overlay-1"), false, "which takes both away");
  // The next lane is numbered past the ones there are, as the Cut numbers a lane it makes for a drop.
  const twice = add(after, 30, "cl_again");
  assert.deepEqual(twice[0], { kind: "add-track", trackId: "tr_overlay-2", trackKind: "picture", name: "Overlay 2" });
});

test("a track with a clip inside the four seconds has no room", () => {
  const at = 300, length = 96;
  const room = (names: TimelineClip[]) => placed(add(timeline({ names }), at)).trackId === "tr_names";
  assert.equal(room([title("cl_x", at + length - 1, "Late", TEXT_DEFAULT_LOOK)]), false, "one that starts in the last frame");
  assert.equal(room([title("cl_x", at - 47, "Early", TEXT_DEFAULT_LOOK)]), false, "one that ends in the first frame");
  assert.equal(room([title("cl_x", at + 10, "Inside", TEXT_DEFAULT_LOOK)]), false, "one inside");
  assert.equal(room([title("cl_x", at + length, "After", TEXT_DEFAULT_LOOK)]), true, "one that starts as the four seconds end");
  assert.equal(room([title("cl_x", at - 48, "Before", TEXT_DEFAULT_LOOK)]), true, "one that ends at the playhead");
});

test("the first text clip takes the default look", () => {
  const look = textLookForNewClip(timeline());
  assert.deepEqual(look, TEXT_DEFAULT_LOOK);
  // 277a: Geist Regular at 8 %, untracked, lines 120 % apart, the middle, 90 % wide, white, a dark shadow straight behind.
  assert.deepEqual(TEXT_DEFAULT_LOOK, { typeface: "geist", weight: "regular", italic: false, size: 0.08, tracking: 0, leading: 1.2, capitals: false,
    align: "center", x: 0.5, y: 0.5, room: 0.9, fill: { kind: "solid", color: "#ffffff" }, shadow: { color: "#000000", opacity: 0.8, blur: 0.3, dx: 0, dy: 0 } });
  // A copy: what a caller does to its look never reaches the next one.
  assert.notEqual(look, TEXT_DEFAULT_LOOK);
  look.size = 0.2; look.fill = { kind: "solid", color: "#000000" };
  assert.deepEqual(textLookForNewClip(timeline()), TEXT_DEFAULT_LOOK);
  assert.ok(Object.isFrozen(TEXT_DEFAULT_LOOK) && Object.isFrozen(TEXT_DEFAULT_LOOK.fill));
});

test("a new clip takes the look most recently placed or changed, not a later trim's", () => {
  const gold = looked({ typeface: "eb-garamond", size: 0.071, y: 0.75, fill: { kind: "solid", color: "#e9c069" } });
  const blue = looked({ typeface: "jost", capitals: true, fill: { kind: "solid", color: "#3050ff" } });
  let base = timeline();
  base = apply(base, [{ kind: "place", trackId: "tr_names", clip: title("cl_ade", 300, "Ade", gold) }]);
  assert.deepEqual(textLookForNewClip(base), gold);
  base = apply(base, [{ kind: "place", trackId: "tr_names", clip: title("cl_ife", 400, "Ife", blue) }]);
  assert.deepEqual(textLookForNewClip(base), blue, "the last one placed");
  // A trim and a fade on the older title change neither its words nor its look.
  base = apply(base, [{ kind: "trim", clipId: "cl_ade", edge: "end", deltaFrames: -8 }]);
  assert.equal(base.tracks.flatMap(track => track.clips).find(clip => clip.id === "cl_ade")!.durationFrames, 40, "the trim landed");
  assert.deepEqual(textLookForNewClip(base), blue, "a trim styles nothing");
  base = apply(base, [{ kind: "picture-fade", clipId: "cl_ade", inFrames: 6 }]);
  assert.deepEqual(textLookForNewClip(base), blue, "nor does a fade");
  // Retyping or restyling a title is a change, and its look is then the one to match.
  base = apply(base, [{ kind: "text-set", clipIds: ["cl_ade"], text: "Adé" }]);
  assert.deepEqual(textLookForNewClip(base), gold, "words retyped");
  base = apply(base, [{ kind: "text-set", clipIds: ["cl_ife"], look: { size: 0.1 } }]);
  assert.deepEqual(textLookForNewClip(base), patchTextLook(blue, { size: 0.1 }), "a look changed");
  // Only the look is copied: the next Add still reads "Text", four seconds, half-second fades.
  const next = placed(add(base, 600));
  assert.ok(next.kind === "place" && next.clip.source.kind === "text");
  assert.deepEqual([next.clip.source.text, next.clip.source.look, next.clip.durationFrames], ["Text", patchTextLook(blue, { size: 0.1 }), 96]);
  // One entry restyling several titles: the last it lists wins, so the answer is the record's alone.
  const both = apply(base, [{ kind: "text-set", clipIds: ["cl_ade", "cl_ife"], look: { x: 0.2 } }]);
  const entry = both.history.undo.at(-1)!;
  assert.ok(entry.kind === "change");
  const last = entry.clips.filter(change => change.after?.source.kind === "text").at(-1)!.after!;
  assert.deepEqual(textLookForNewClip(both), lookOf(both, last.id));
});

test("after Undo, a new clip takes the look before the undone change", () => {
  const first = looked({ typeface: "cinzel" }), base = apply(timeline(), [{ kind: "place", trackId: "tr_names", clip: title("cl_ade", 300, "Ade", first) }]);
  const restyled = apply(base, [{ kind: "text-set", clipIds: ["cl_ade"], look: { typeface: "comic-neue", size: 0.12 } }]);
  assert.deepEqual(textLookForNewClip(restyled), patchTextLook(first, { typeface: "comic-neue", size: 0.12 }));
  const undone = undoTimelineHistory(restyled);
  assert.deepEqual(textLookForNewClip(undone), first, "what the person is now looking at");
});

test("with no text in Undo, the latest text clip on the timeline lends its look", () => {
  const early = looked({ x: 0.1, align: "left" }), late = looked({ x: 0.9, align: "right" }), high = looked({ y: 0.25 });
  const base = timeline({ names: [title("cl_early", 300, "Early", early), title("cl_late", 500, "Late", late)] });
  assert.deepEqual(base.history.undo, []);
  assert.deepEqual(textLookForNewClip(base), late, "the one that starts latest");
  // Two starting together: the higher track's.
  const tied = timeline({ names: [title("cl_late", 500, "Late", late)], base: [still("cl_a", 0, 120), title("cl_low", 500, "Low", high)] });
  assert.deepEqual(textLookForNewClip(tied), late);
  // Undo that holds no title is passed over to the timeline, as an Undo of nothing but stills is.
  const stills = apply(base, [{ kind: "place", trackId: "tr_picture", clip: still("cl_c", 216, 24) }]);
  assert.deepEqual(textLookForNewClip(stills), late);
});

test("the default look and every part default parse as a look", () => {
  assert.deepEqual(TextLookSchema.parse(TEXT_DEFAULT_LOOK), TEXT_DEFAULT_LOOK);
  const { edge, shadow, rule, shade, box } = TEXT_PART_DEFAULTS;
  const full = { ...TEXT_DEFAULT_LOOK, edge, shadow, rule };
  for (const backing of [shade, box]) assert.deepEqual(TextLookSchema.parse({ ...full, backing }), { ...full, backing });
  for (const patch of [{ edge }, { shadow }, { rule }, { backing: shade }, { backing: box }]) assert.ok(TextLookPatchSchema.safeParse(patch).success);
  assert.deepEqual([shade.kind, box.kind], ["shade", "box"]);
  // 277d's promo, in black: an edge 2.2 % of the size, a halo at 85 % and 35 %, a faded rule 17.8 % of the frame, a 45 % backing.
  assert.deepEqual(TEXT_PART_DEFAULTS, {
    edge: { color: "#000000", width: 0.022 }, shadow: { color: "#000000", opacity: 0.85, blur: 0.35, dx: 0, dy: 0 },
    rule: { length: 0.178, weight: 0.03, gap: 0.35, soft: true },
    shade: { kind: "shade", color: "#000000", opacity: 0.45 }, box: { kind: "box", color: "#000000", opacity: 0.45 },
  });
  assert.ok(Object.isFrozen(TEXT_PART_DEFAULTS) && Object.values(TEXT_PART_DEFAULTS).every(Object.isFrozen));
});

test("choosing a typeface sets Regular or upright with it wherever a clip needs it, one patch for every clip", () => {
  const regular = { weight: "regular", italic: false } as const, bold = { weight: "bold", italic: false } as const;
  const italic = { weight: "regular", italic: true } as const, both = { weight: "bold", italic: true } as const;
  assert.deepEqual(textTypefacePatch("jost", [both]), { typeface: "jost" }, "a face with all four needs nothing more");
  assert.deepEqual(textTypefacePatch("bangers", [both]), { typeface: "bangers", weight: "regular", italic: false });
  assert.deepEqual(textTypefacePatch("bangers", [regular]), { typeface: "bangers" });
  assert.deepEqual(textTypefacePatch("geist", [both]), { typeface: "geist", italic: false }, "bold stays where the face has bold");
  assert.deepEqual(textTypefacePatch("cinzel", [italic]), { typeface: "cinzel", italic: false });
  assert.deepEqual(textTypefacePatch("bangers", [regular, bold]), { typeface: "bangers", weight: "regular" }, "what one needs, all are given");
  assert.deepEqual(textTypefacePatch("geist", [regular, italic]), { typeface: "geist", italic: false });
  assert.deepEqual(textTypefacePatch("eb-garamond", []), { typeface: "eb-garamond" });
  // Whatever the clips and whatever the face, every clip draws after the patch.
  const styles = [regular, bold, italic, both];
  for (const typeface of TEXT_TYPEFACE_IDS) for (const a of styles) for (const b of styles) {
    const patch = textTypefacePatch(typeface, [a, b]);
    for (const look of [a, b]) assert.ok(textTypefaceFile(typeface, patch.weight ?? look.weight, patch.italic ?? look.italic).ok, `${typeface} ${JSON.stringify([a, b])}`);
  }
});

test("the Inspector's bounds are the record's own, field by field", () => {
  // Every number a look can hold, found by walking the schema, and no other.
  const numbers: string[] = [];
  const walk = (shape: z.ZodRawShape, path: string[]) => {
    for (const [key, field] of Object.entries(shape)) {
      const inner = field instanceof z.ZodOptional ? field.unwrap() : field;
      if (inner instanceof z.ZodNumber) numbers.push([...path, key].join("."));
      else if (inner instanceof z.ZodObject) walk(inner.shape as z.ZodRawShape, [...path, key]);
    }
  };
  walk(TextLookSchema.shape, []);
  assert.deepEqual(Object.keys(TEXT_LOOK_BOUNDS).sort(), numbers.sort());
  assert.deepEqual(TEXT_LOOK_BOUNDS.size, { min: 0.01, max: 0.4 });
  assert.deepEqual(TEXT_LOOK_BOUNDS["shadow.dx"], { min: -1, max: 1 });
  // Each bound is one a look holds, and a hair past it is refused.
  const full = { ...TEXT_DEFAULT_LOOK, ...TEXT_PART_DEFAULTS, backing: TEXT_PART_DEFAULTS.box } as Record<string, unknown>;
  delete full.shade; delete full.box;
  const at = (path: string, value: number) => {
    const look = structuredClone(full) as Record<string, Record<string, unknown> | unknown>, [head, tail] = path.split(".");
    if (tail === undefined) look[head!] = value; else (look[head!] as Record<string, unknown>)[tail] = value;
    return TextLookSchema.safeParse(look).success;
  };
  for (const [path, { min, max }] of Object.entries(TEXT_LOOK_BOUNDS)) {
    assert.ok(Number.isFinite(min) && Number.isFinite(max) && min < max, path);
    assert.deepEqual([at(path, min), at(path, max), at(path, min - 0.001), at(path, max + 0.001)], [true, true, false, false], path);
  }
});
