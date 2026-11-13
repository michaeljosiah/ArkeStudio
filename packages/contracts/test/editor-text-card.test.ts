import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MIX,
  ModelEditorRequestSchema,
  ProductionTimelineSchema,
  TEXT_PLACES,
  TEXT_REQUEST_GUIDE,
  TEXT_TYPEFACES,
  TEXT_TYPEFACE_IDS,
  TEXT_TYPEFACE_STYLES,
  TIMELINE_EDITOR_COMMAND_GUIDE,
  TextFillSchema,
  TextLookSchema,
  applyTimelineCommands,
  describeEditorTextChange,
  editorTextChanges,
  namedTextPlace,
  textLookValues,
  textPlaceLabel,
  type ProductionTimeline,
  type TextLook,
  type TimelineClip,
  type TimelineTrack,
} from "../src/index.js";

// How a text clip reads on a request's card and to Arke (SPEC-065 R-35, R-36): a place by its name
// only when the look sits exactly there, every value in the Inspector's per cents, clips paired by
// id across tracks, and a guide whose faces, places and bounds are the record's own.

const PROMO: TextLook = { typeface: "eb-garamond", weight: "regular", italic: false, size: 0.071, tracking: 0, leading: 1.2, capitals: false, align: "center",
  x: 0.5, y: 0.75, room: 0.815,
  fill: { kind: "gradient", stops: [{ at: 0, color: "#F6DA94" }, { at: 0.38, color: "#e9c069" }, { at: 0.7, color: "#c9973d" }, { at: 1, color: "#9c6a1e" }] },
  edge: { color: "#1a1208", width: 0.022 }, shadow: { color: "#000000", opacity: 0.85, blur: 0.25, dx: 0, dy: 0.03 },
  rule: { length: 0.178, weight: 0.022, gap: 0.42, soft: true }, backing: { kind: "shade", color: "#060402", opacity: 0.9 } };
const PLAIN: TextLook = { typeface: "geist", weight: "regular", italic: false, size: 0.08, tracking: 0, leading: 1.2, capitals: false, align: "center",
  x: 0.5, y: 0.5, room: 0.8, fill: { kind: "solid", color: "#ffffff" } };

test("a look reads as a named place only when x, y and the alignment all match one", () => {
  for (const place of TEXT_PLACES) {
    assert.equal(textPlaceLabel(place), place.name);
    assert.equal(namedTextPlace(place), place.name);
    // Every place is one a look can hold.
    assert.equal(TextLookSchema.safeParse({ ...PLAIN, x: place.x, y: place.y, align: place.align }).success, true, place.name);
  }
  assert.deepEqual(TEXT_PLACES.map(place => place.name), ["Middle", "Lower third", "Upper third", "Lower left", "Lower right"]);
  assert.equal(textPlaceLabel({ x: 0.5, y: 0.75, align: "left" }), "X 50%, Y 75%, Left", "Lower third's spot, aligned otherwise, is not Lower third");
  assert.equal(namedTextPlace({ x: 0.5, y: 0.75, align: "left" }), null);
  assert.equal(textPlaceLabel({ x: 0.08, y: 0.72, align: "left" }), "X 8%, Y 72%, Left");
  assert.equal(textPlaceLabel({ x: 0.5, y: 0.7, align: "center" }), "X 50%, Y 70%, Centre");
  assert.equal(textPlaceLabel({ x: 0.9, y: 0.75, align: "right" }), "Lower right");
});

test("values read in the Inspector's units: per cents of the frame or the size, colours lower-cased, absent parts None", () => {
  assert.deepEqual(textLookValues(PROMO), [
    ["Typeface", "EB Garamond"],
    ["Weight", "Regular"],
    ["Italic", "Off"],
    ["Capitals", "Off"],
    // 0.071 and 0.022 are 7.1000000000000005 and 2.1999999999999997 per cent in floating point.
    ["Size", "7.1%"],
    ["Tracking", "0%"],
    ["Line", "120%"],
    ["Place", "Lower third"],
    ["Max width", "81.5%"],
    ["Fill", "#f6da94 0%, #e9c069 38%, #c9973d 70%, #9c6a1e 100%"],
    ["Edge", "#1a1208, width 2.2%"],
    ["Shadow", "#000000, opacity 85%, softness 25%, X 0%, Y 3%"],
    ["Rule", "length 17.8%, thickness 2.2%, distance 42%, faded ends"],
    ["Backing", "Shade, #060402, opacity 90%"],
  ]);
  const plain = new Map(textLookValues({ ...PLAIN, weight: "bold", italic: true, capitals: true, tracking: -0.05, x: 0.08, y: 0.72, align: "left" }));
  assert.equal(plain.get("Fill"), "#ffffff");
  assert.equal(plain.get("Weight"), "Bold");
  assert.equal(plain.get("Italic"), "On");
  assert.equal(plain.get("Capitals"), "On");
  assert.equal(plain.get("Tracking"), "-5%");
  assert.equal(plain.get("Place"), "X 8%, Y 72%, Left");
  for (const part of ["Edge", "Shadow", "Rule", "Backing"]) assert.equal(plain.get(part), "None", part);
  const hard = new Map(textLookValues({ ...PROMO, rule: { length: 0.3, weight: 0.03, gap: 0.3, soft: false }, backing: { kind: "box", color: "#101418", opacity: 0.82 } }));
  assert.equal(hard.get("Rule"), "length 30%, thickness 3%, distance 30%", "faded ends only when the rule is soft");
  assert.equal(hard.get("Backing"), "Box, #101418, opacity 82%");
});

const text = (id: `cl_${string}`, words: string, startFrame: number, look: TextLook = PLAIN): TimelineClip =>
  ({ id, startFrame, durationFrames: 48, sourceInFrames: 0, source: { kind: "text", label: words.split("\n")[0]!, text: words, look } });
const still = (id: `cl_${string}`, startFrame: number): TimelineClip =>
  ({ id, startFrame, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: "ar_01J8G0000000000000000000R3", label: "Still" } });
const track = (id: `tr_${string}`, name: string, order: number, clips: TimelineClip[]): TimelineTrack =>
  ({ id, kind: "picture", name, order, muted: false, clips });
const timeline = (tracks: TimelineTrack[]): ProductionTimeline =>
  ProductionTimelineSchema.parse({ schemaVersion: 1, revision: 1, frameRate: 24, tracks, history: { undo: [], redo: [] }, mix: DEFAULT_MIX });

test("text clips are paired by id across tracks: added, removed, changed, and a fade or motion alone lists nothing", () => {
  const before = timeline([track("tr_picture", "Picture", 0, [still("cl_still", 0), text("cl_ade", "Ade", 120)]),
    track("tr_names", "Names", 1, [text("cl_kemi", "Kemi", 200), text("cl_ife", "Ifẹ", 300)])]);

  // The same clip on another track is one change, by track, not a removal and an add.
  const moved = { tracks: [track("tr_picture", "Picture", 0, [still("cl_still", 0)]),
    track("tr_names", "Names", 1, [text("cl_ade", "Ade", 120), text("cl_kemi", "Kemi", 200), text("cl_ife", "Ifẹ", 300)])] };
  assert.deepEqual(editorTextChanges(before, moved), [{ change: "change", clipId: "cl_ade", words: "Ade", track: "Names", startFrame: 120, endFrame: 168,
    place: "Middle", values: [{ label: "Track", before: "Picture", after: "Names" }] }]);

  // A split: the head's frames change and the tail is added, words and look on both.
  const split = applyTimelineCommands(before, [{ kind: "split", clipId: "cl_kemi", atFrame: 220, newClipId: "cl_kemi_tail" }]);
  assert.deepEqual(editorTextChanges(before, split).map(describeEditorTextChange), [
    "Changes text “Kemi” · Frames 200–248 → 200–220",
    "Adds text “Kemi” · Names · frames 220–248 · Middle",
  ]);

  // A delete, listed after the clips the after timeline holds.
  const deleted = applyTimelineCommands(before, [{ kind: "delete", clipId: "cl_kemi" }, { kind: "text-set", clipIds: ["cl_ife"], text: "Ifẹ\nthe singer" }]);
  assert.deepEqual(editorTextChanges(before, deleted).map(describeEditorTextChange), [
    "Changes text “Ifẹ” · Words “Ifẹ” → “Ifẹ ⏎ the singer”",
    "Removes text “Kemi” · Names · frames 200–248 · Middle",
  ]);

  // A typed slash is not a line break: a change that only breaks a line, or joins one, is stated
  // like any other, and its before and after read apart.
  const typed = timeline([track("tr_picture", "Picture", 0, [text("cl_ade", "Ade / the healer", 120)])]);
  const broken = applyTimelineCommands(typed, [{ kind: "text-set", clipIds: ["cl_ade"], text: "Ade\nthe healer" }]);
  assert.notEqual(broken, typed, "the reducer writes it as a change");
  assert.deepEqual(editorTextChanges(typed, broken).map(describeEditorTextChange), ["Changes text “Ade / the healer” · Words “Ade / the healer” → “Ade ⏎ the healer”"]);
  assert.deepEqual(editorTextChanges(broken, typed).map(describeEditorTextChange), ["Changes text “Ade ⏎ the healer” · Words “Ade ⏎ the healer” → “Ade / the healer”"]);
  assert.deepEqual(editorTextChanges(typed, broken).map(change => change.words), ["Ade / the healer"], "the words as stored");
  // Added, the two read apart as well.
  const both = { tracks: [track("tr_picture", "Picture", 0, [text("cl_ade", "Ade / the healer", 120), text("cl_ife", "Ade\nthe healer", 300)])] };
  assert.deepEqual(editorTextChanges({ tracks: [] }, both).map(describeEditorTextChange),
    ["Adds text “Ade / the healer” · Picture · frames 120–168 · Middle", "Adds text “Ade ⏎ the healer” · Picture · frames 300–348 · Middle"]);

  // A fade, a still's move and a still's motion are the generic lines' to state.
  const faded = applyTimelineCommands(before, [{ kind: "picture-fade", clipId: "cl_ade", inFrames: 12 }, { kind: "move-to-frame", clipId: "cl_still", startFrame: 400 },
    { kind: "picture-motion", clipId: "cl_still", motion: { kind: "push-in", amount: 0.1 } }]);
  assert.deepEqual(editorTextChanges(before, faded), []);
  assert.deepEqual(editorTextChanges(before, before), []);

  // Several values of one clip, in the Inspector's order, each before and after.
  const restyled = applyTimelineCommands(before, [{ kind: "text-set", clipIds: ["cl_ife"], look: { typeface: "eb-garamond", size: 0.1, edge: { color: "#1A1208", width: 0.02 } } }]);
  assert.deepEqual(editorTextChanges(before, restyled).map(describeEditorTextChange),
    ["Changes text “Ifẹ” · Typeface Geist → EB Garamond · Size 8% → 10% · Edge None → #1a1208, width 2%"]);
});

/** The bounds Arke is told, as `<field path> <least> <most>`: every numeric bound the look holds. */
const BOUNDS: readonly (readonly [path: string, min: number, max: number])[] = [
  ["size", 0.01, 0.4], ["tracking", -0.05, 0.5], ["leading", 0.8, 2], ["room", 0.1, 1], ["x", 0, 1], ["y", 0, 1],
  ["edge.width", 0.005, 0.2], ["shadow.opacity", 0, 1], ["shadow.blur", 0, 1], ["shadow.dx", -1, 1], ["shadow.dy", -1, 1],
  ["rule.length", 0.02, 1], ["rule.weight", 0.005, 0.2], ["rule.gap", 0, 2], ["backing.opacity", 0, 1],
];
/** The promo look with one value set, by a path like "shadow.blur". */
function lookWith(path: string, value: number): unknown {
  const [part, leaf] = path.split(".");
  const look: Record<string, unknown> = { ...PROMO };
  look[part!] = leaf === undefined ? value : Object.assign({}, look[part!], { [leaf]: value });
  return look;
}

test("the guide tells Arke every face and style, Capitals, the named places and text-set, and its bounds are the record's", () => {
  for (const id of TEXT_TYPEFACE_IDS) {
    const styles = TEXT_TYPEFACE_STYLES.filter(style => TEXT_TYPEFACES[id].files[style] !== undefined).map(style => style.replace("-", " "));
    // The id and then exactly the styles it ships: nothing after them but the next face or clause.
    assert.match(TEXT_REQUEST_GUIDE, new RegExp(`(?:: |; )${id} ${styles.join(", ")}(?:;| \\|)`), id);
  }
  assert.ok(TEXT_REQUEST_GUIDE.includes("bangers regular;"), "a face with one style lists only that one");
  for (const said of ["capitals true draws upper case and keeps the words as typed", "text-set sets look fields on 1 to 50 text clips, and the words too when it names one",
    "null removes edge, shadow, rule or backing", "only eb-garamond draws ẹ, ọ and ṣ", "stops: 2 to 4 of {at 0 to 1, color}"]) {
    assert.ok(TEXT_REQUEST_GUIDE.includes(said), said);
  }
  for (const place of TEXT_PLACES) assert.ok(TEXT_REQUEST_GUIDE.includes(`${place.name} x ${place.x}, y ${place.y}, ${place.align}`), place.name);

  for (const [path, min, max] of BOUNDS) {
    assert.ok(TEXT_REQUEST_GUIDE.includes(`${path.split(".").at(-1)} ${min} to ${max}`), path);
    for (const value of [min, max]) assert.equal(TextLookSchema.safeParse(lookWith(path, value)).success, true, `${path} ${value}`);
    for (const value of [min - 0.001, max + 0.001]) assert.equal(TextLookSchema.safeParse(lookWith(path, value)).success, false, `${path} ${value}`);
  }
  const stops = (count: number) => ({ kind: "gradient", stops: Array.from({ length: count }, (_, index) => ({ at: index / 4, color: "#ffffff" })) });
  assert.deepEqual([1, 2, 4, 5].map(count => TextFillSchema.safeParse(stops(count)).success), [false, true, true, false], "2 to 4 stops, as the guide says");

  // The guide sits inside the command list, so no clause of it may read as a command that is not one.
  const allowed = ModelEditorRequestSchema.shape.commands.element.options.map(option => option.shape.kind.value);
  assert.deepEqual([...TIMELINE_EDITOR_COMMAND_GUIDE.matchAll(/(?:^| \| )([a-z-]+) \(/g)].map(match => match[1]), allowed);
  assert.ok(TIMELINE_EDITOR_COMMAND_GUIDE.includes(TEXT_REQUEST_GUIDE));
  assert.equal(TIMELINE_EDITOR_COMMAND_GUIDE.includes("\n"), false, "the guide is one line of the action guide");
});
