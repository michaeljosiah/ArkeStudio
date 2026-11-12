import assert from "node:assert/strict";
import { test } from "node:test";
import type { TextFrame, TextInk } from "../src/editor-text.js";
import { TEXT_FRAME_MAX, TEXT_FRAME_MIN, layoutText, textDisplayLines, textFillAt, textRgb, type TextLayout } from "../src/editor-text-layout.js";
import { PROOF_FRAME, proofFace, proofInk } from "./editor-text-fixture.js";

// Where the words fall (SPEC-065 R-5, R-8 – R-10). The proof face has 8 units to the em, an ascent
// of 6, a descent of 2 and capitals 4 high; on the 64-pixel proof frame its em is 8 pixels, so
// every number below can be worked out by hand: one line sits from 28 to 36, on a baseline at 34.

function lay(words: string, changes: Partial<TextInk> = {}, frame: TextFrame = PROOF_FRAME): TextLayout {
  const laid = layoutText(words, proofInk(changes), frame, proofFace().face);
  if (!laid.ok) throw new Error(laid.reason);
  return laid.layout;
}
const refusal = (words: string, changes: Partial<TextInk> = {}, frame: TextFrame = PROOF_FRAME) => {
  const laid = layoutText(words, proofInk(changes), frame, proofFace().face);
  return laid.ok ? "laid out" : laid.reason;
};
const starts = (layout: TextLayout, line = 0) => layout.lines[line]!.glyphs.map(glyph => glyph.x);
/** Fit multiplies by a ratio that is not a whole number of pixels: equal to within rounding of the last few bits. */
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test("one line is placed by its size, its anchor and the face's own measures", () => {
  const layout = lay("a");
  assert.deepEqual(layout.frame, PROOF_FRAME);
  assert.equal(layout.em, 8);
  assert.equal(layout.unit, 1);
  assert.equal(layout.factor, 1);
  assert.equal(layout.drawnSize, 0.125);
  assert.equal(layout.lines.length, 1);
  const line = layout.lines[0]!;
  assert.deepEqual({ text: line.text, baseline: line.baseline, capLine: line.capLine, start: line.start, width: line.width }, { text: "a", baseline: 34, capLine: 30, start: 16, width: 5 });
  assert.deepEqual(line.glyphs.map(({ x, y }) => [x, y]), [[16, 34]]);
  assert.deepEqual(layout.block, { left: 16, top: 28, right: 21, bottom: 36 });
  assert.deepEqual(layout.bounds, layout.block);
  assert.equal(layout.rule, undefined);
  // The same record at twice the frame is the same picture at twice the size: every length is a fraction.
  const doubled = lay("a", {}, { width: 128, height: 128 });
  assert.equal(doubled.em, 16);
  assert.equal(doubled.unit, 2);
  assert.deepEqual(doubled.block, { left: 32, top: 56, right: 42, bottom: 72 });
  // The em follows the frame's height and the anchor its width.
  const wide = lay("a", {}, { width: 128, height: 64 });
  assert.equal(wide.em, 8);
  assert.deepEqual(wide.block, { left: 32, top: 28, right: 37, bottom: 36 });
});

test("left, centre and right set each line against the anchor on its own", () => {
  assert.deepEqual(starts(lay("aa")), [16, 21]);
  assert.deepEqual(starts(lay("aa", { align: "center", x: 0.5 })), [27, 32]);
  assert.deepEqual(starts(lay("aa", { align: "right", x: 0.75 })), [38, 43]);
  const left = lay("aa\na"), centre = lay("aa\na", { align: "center", x: 0.5 }), right = lay("aa\na", { align: "right", x: 0.75 });
  assert.deepEqual(left.lines.map(line => line.start), [16, 16]);
  // Half a pixel is kept: a centred odd width is not nudged onto the grid.
  assert.deepEqual(centre.lines.map(line => line.start), [27, 29.5]);
  assert.deepEqual(starts(centre, 1), [29.5]);
  assert.deepEqual(right.lines.map(line => line.start), [38, 43]);
  // The block runs from the leftmost start to the rightmost end, whichever lines those are.
  assert.deepEqual([left.block.left, left.block.right], [16, 26]);
  assert.deepEqual([centre.block.left, centre.block.right], [27, 37]);
  assert.deepEqual([right.block.left, right.block.right], [38, 48]);
  // The wider line second: the first line alone would give a block half as wide.
  assert.deepEqual(lay("a\naa").block, { left: 16, top: 24, right: 26, bottom: 40 });
  assert.deepEqual(lay("a\naa", { align: "center", x: 0.5 }).block, { left: 27, top: 24, right: 37, bottom: 40 });
  assert.deepEqual(lay("a\naa", { align: "right", x: 0.75 }).block, { left: 38, top: 24, right: 48, bottom: 40 });
  assert.deepEqual(lay("a\naa", { align: "right", x: 0.75 }).bounds, { left: 38, top: 24, right: 48, bottom: 40 });
  assert.deepEqual(lay("a\naaa\naa", { align: "center", x: 0.5 }).block, { left: 24.5, top: 20, right: 39.5, bottom: 44 });
});

test("a glyph sits where the shaping puts it from the pen: across by dx, and up the frame by dy", () => {
  // The pen is at 21 after the "v". The acute is set back three units and drawn above the cap line by its own outline.
  assert.deepEqual(lay("v\u0301").lines[0]!.glyphs.map(({ x, y }) => [x, y]), [[16, 34], [18, 34]]);
  // The grave is drawn on the baseline and lifted five units by the shaping: five pixels up the frame, which is a smaller y.
  assert.deepEqual(lay("v\u0300").lines[0]!.glyphs.map(({ x, y }) => [x, y]), [[16, 34], [18, 29]]);
  // Both offsets are the face's units, so they grow with the type: a 16-pixel em doubles them.
  assert.deepEqual(lay("v\u0300", { size: 0.25 }).lines[0]!.glyphs.map(({ x, y }) => [x, y]), [[16, 36], [20, 26]]);
  // A mark takes no room: the line is as wide as its letter, and the letter after it starts where it would have.
  assert.equal(lay("v\u0300").lines[0]!.width, 5);
  assert.deepEqual(starts(lay("v\u0300a")), [16, 18, 21]);
});

test("words with nothing in them refuse, and so does a gradient with no colours: a clip is never a blank (SPEC-065 R-3, R-4)", () => {
  for (const words of ["", "\n\n", "   ", " \n \n", "\n"]) assert.equal(refusal(words), "Type some words", JSON.stringify(words));
  // Asked before the face is, so a face that has no space is not the reason given.
  const { face, asked } = proofFace();
  assert.deepEqual(layoutText(" ", proofInk(), PROOF_FRAME, { ...face, has: () => false }), { ok: false, reason: "Type some words" });
  assert.deepEqual(asked, []);
  // A blank line between words is the author's and stays.
  assert.deepEqual(lay("a\n\na").lines.map(line => line.baseline), [26, 34, 42]);
  assert.equal(lay(" a").lines[0]!.width, 8);
  // The record holds two stops or more. Handed none, there is no colour to draw in: a reason, not a thrown TypeError.
  const empty = { kind: "gradient" as const, stops: [] };
  assert.equal(refusal("a", { fill: empty }), "A gradient fill has no colours");
  assert.equal(refusal("a", { fill: empty, rule: { length: 0.5, weight: 0.125, gap: 0.25, soft: false } }), "A gradient fill has no colours");
});

test("the block's middle sits at y, and leading sets its baselines apart", () => {
  assert.deepEqual(lay("a", { y: 0.25 }).block, { left: 16, top: 12, right: 21, bottom: 20 });
  const two = lay("a\na");
  assert.deepEqual(two.lines.map(line => line.baseline), [30, 38]);
  assert.deepEqual(two.lines.map(line => line.capLine), [26, 34]);
  assert.deepEqual([two.block.top, two.block.bottom], [24, 40]);
  const loose = lay("a\na", { leading: 1.5 });
  assert.deepEqual(loose.lines.map(line => line.baseline), [28, 40]);
  assert.deepEqual([loose.block.top, loose.block.bottom], [22, 42]);
  const tight = lay("a\na", { leading: 0.8 });
  near(tight.lines[1]!.baseline - tight.lines[0]!.baseline, 6.4);
  near((tight.block.top + tight.block.bottom) / 2, 32);
  // A blank line inside the words is a line: it holds its place and nothing is shaped for it.
  const { face, asked } = proofFace(), gap = layoutText("a\n\na", proofInk(), PROOF_FRAME, face);
  assert.equal(gap.ok, true);
  if (gap.ok) {
    assert.deepEqual(gap.layout.lines.map(line => line.baseline), [26, 34, 42]);
    assert.deepEqual(gap.layout.lines.map(line => [line.text, line.width, line.start, line.glyphs.length]), [["a", 5, 16, 1], ["", 0, 16, 0], ["a", 5, 16, 1]]);
  }
  assert.deepEqual(asked.map(ask => ask.line), ["a", "a"]);
});

test("tracking falls between characters only, and never around a mark (SPEC-065 R-8)", () => {
  const tracked = lay("aaa", { tracking: 0.25 });
  assert.deepEqual(starts(tracked), [16, 23, 30]);
  // 15 of letters and two gaps of 2: no gap after the last, so a centred line is centred on its letters.
  assert.equal(tracked.lines[0]!.width, 19);
  assert.deepEqual(starts(lay("aaa", { tracking: 0.25, align: "center", x: 0.5 })), [22.5, 29.5, 36.5]);
  assert.equal(lay("a", { tracking: 0.5 }).lines[0]!.width, 5);
  // A mark is drawn back over its letter and takes no gap before it; the letter after it takes one.
  const marked = lay("v́a", { tracking: 0.25 });
  assert.deepEqual(marked.lines[0]!.glyphs.map(({ glyph, x }) => [glyph.mark, x]), [[false, 16], [true, 18], [false, 23]]);
  assert.equal(marked.lines[0]!.width, 12);
  assert.deepEqual(starts(lay("v́a")), [16, 18, 21]);
  const closer = lay("aa", { tracking: -0.05 });
  near(closer.lines[0]!.glyphs[1]!.x, 20.6);
  near(closer.lines[0]!.width, 9.6);
  // A space is a character like any other.
  assert.deepEqual(starts(lay("a a", { tracking: 0.125 })), [16, 22, 26]);
});

test("kerning is kept, tracked or not", () => {
  assert.deepEqual(starts(lay("av")), [16, 20]);
  assert.equal(lay("av").lines[0]!.width, 9);
  assert.deepEqual(starts(lay("va")), [16, 21]);
  assert.deepEqual(starts(lay("av", { tracking: 0.125 })), [16, 21]);
  assert.equal(lay("av", { tracking: 0.125 }).lines[0]!.width, 10);
});

test("ligatures are asked for only when the line is not tracked", () => {
  for (const [tracking, ligatures, glyphs, width] of [[0, true, [[0x66, 0x69]], 5], [0.125, false, [[0x66], [0x69]], 6], [-0.05, false, [[0x66], [0x69]], 4.6]] as const) {
    const { face, asked } = proofFace(), laid = layoutText("fi", proofInk({ tracking }), PROOF_FRAME, face);
    assert.deepEqual(asked, [{ line: "fi", ligatures }]);
    assert.equal(laid.ok, true);
    if (!laid.ok) continue;
    assert.deepEqual(laid.layout.lines[0]!.glyphs.map(({ glyph }) => glyph.codePoints), glyphs);
    near(laid.layout.lines[0]!.width, width);
  }
  assert.deepEqual(starts(lay("fi", { tracking: 0.125 })), [16, 20]);
});

test("the words are composed before they are shaped", () => {
  // The face has the precomposed letter and no plain "e": only a composed line can be drawn at all.
  const layout = lay("é");
  assert.equal(layout.lines[0]!.text, "é");
  assert.deepEqual(layout.lines[0]!.glyphs.map(({ glyph }) => glyph.codePoints), [[0xe9]]);
  assert.equal(refusal("e"), "Proof has no e");
  assert.deepEqual(textDisplayLines("é\nv́", false), ["é", "v́"]);
});

test("Fit draws the whole block smaller and leaves the stored size alone (SPEC-065 R-10)", () => {
  // Eight letters are 40 pixels at the chosen size; half the frame is 32.
  const ink = proofInk({ room: 0.5, leading: 1.5, rule: { length: 0.5, weight: 0.125, gap: 0.25, soft: false } }), stored = structuredClone(ink);
  const laid = layoutText("aaaaaaaa\na", ink, PROOF_FRAME, proofFace().face);
  assert.deepEqual(ink, stored);
  assert.equal(laid.ok, true);
  if (!laid.ok) return;
  const { layout } = laid;
  near(layout.factor, 0.8);
  near(layout.drawnSize, 0.1);
  near(layout.em, 6.4);
  near(layout.unit, 0.8);
  // Every line is still there, each smaller by the one factor.
  assert.equal(layout.lines.length, 2);
  near(layout.lines[0]!.width, 32);
  near(layout.lines[1]!.width, 4);
  layout.lines[0]!.glyphs.forEach(({ x }, index) => near(x, 16 + index * 4));
  // What is measured in ems shrinks with the type: leading, the face's measures, the rule's weight and gap.
  near(layout.lines[1]!.baseline - layout.lines[0]!.baseline, 9.6);
  near(layout.lines[0]!.baseline - layout.lines[0]!.capLine, 3.2);
  near(layout.block.bottom - layout.block.top, 6.4 + 9.6);
  near((layout.block.top + layout.block.bottom) / 2, 32);
  near(layout.rule!.box.top - layout.lines[1]!.baseline, 1.6);
  near(layout.rule!.box.bottom - layout.rule!.box.top, 0.8);
  // What is measured against the frame does not: the anchor, and the rule's length.
  assert.equal(layout.lines[0]!.start, 16);
  assert.equal(layout.rule!.box.left, 16);
  assert.equal(layout.rule!.box.right, 48);
});

test("Fit counts tracking, and a line that just fits is drawn at the size chosen", () => {
  assert.equal(lay("aaaaaaaa", { room: 0.625 }).factor, 1);
  assert.equal(lay("aaaaaaaa", { room: 1 }).factor, 1);
  // Four letters are 20 pixels and their three gaps 12: 32 against a room of 16.
  const tracked = lay("aaaa", { tracking: 0.5, room: 0.25 });
  near(tracked.factor, 0.5);
  near(tracked.lines[0]!.width, 16);
  tracked.lines[0]!.glyphs.forEach(({ x }, index) => near(x, 16 + index * 4.5));
  // The widest line decides, wherever it is.
  near(lay("a\naaaaaaaa\na", { room: 0.5 }).factor, 0.8);
  // Fit only ever shrinks: room to spare never draws the words larger.
  assert.equal(lay("a", { room: 1 }).drawnSize, 0.125);
});

test("Capitals shapes the words in upper case and leaves them as typed (SPEC-065 R-4)", () => {
  const { face, asked } = proofFace(), laid = layoutText("av", proofInk({ capitals: true }), PROOF_FRAME, face);
  assert.deepEqual(asked, [{ line: "AV", ligatures: true }]);
  assert.equal(laid.ok, true);
  if (laid.ok) {
    assert.equal(laid.layout.lines[0]!.text, "AV");
    // The capital's own advance, and no kerning the lower-case pair had.
    assert.deepEqual(laid.layout.lines[0]!.glyphs.map(glyph => glyph.x), [16, 22]);
    assert.equal(laid.layout.lines[0]!.width, 12);
  }
  assert.deepEqual(textDisplayLines("av\né", true), ["AV", "É"]);
  assert.deepEqual(textDisplayLines("av", false), ["av"]);
  // Never by the machine's locale: a Turkish one would dot the capital I.
  assert.deepEqual(textDisplayLines("ife\nIstanbul i", true), ["IFE", "ISTANBUL I"]);
  assert.deepEqual(textDisplayLines("ife", false), ["ife"]);
  // Capitals off shapes the words as they were typed.
  const plain = proofFace(), typed = layoutText("av", proofInk(), PROOF_FRAME, plain.face);
  assert.deepEqual(plain.asked, [{ line: "av", ligatures: true }]);
  assert.ok(typed.ok && typed.layout.lines[0]!.text === "av");
  // What is drawn is what is asked of the face: the face has a "q" and no "Q".
  assert.equal(refusal("aq"), "laid out");
  assert.equal(refusal("aq", { capitals: true }), "Proof has no Q");
});

test("a character the face lacks refuses by name, and nothing is shaped (SPEC-065 R-21)", () => {
  assert.equal(refusal("az"), "Proof has no z");
  assert.equal(refusal("a?"), "Proof has no ?");
  assert.equal(refusal("a€"), "Proof has no €");
  assert.equal(refusal("a\u{1F600}"), "Proof has no \u{1F600}");
  // A character nobody could see in the sentence is named by its code point.
  assert.equal(refusal("a\tv"), "Proof has no U+0009");
  assert.equal(refusal("a v"), "Proof has no U+00A0");
  assert.equal(refusal("a​v"), "Proof has no U+200B");
  assert.equal(refusal("a\u{E0001}v"), "Proof has no U+E0001");
  // The first one missing, in reading order, across lines.
  assert.equal(refusal("a\tz"), "Proof has no U+0009");
  assert.equal(refusal("a\nz\n\t"), "Proof has no z");
  const { face, asked } = proofFace();
  assert.deepEqual(layoutText("aa\naz", proofInk(), PROOF_FRAME, face), { ok: false, reason: "Proof has no z" });
  assert.deepEqual(asked, []);
});

test("a block that overhangs the frame is laid out, not refused (SPEC-065 R-9)", () => {
  const right = lay("aaaa", { x: 0.9 });
  near(right.block.left, 57.6);
  near(right.block.right, 77.6);
  assert.deepEqual(lay("aaaa", { x: 0, align: "right" }).block, { left: -20, top: 28, right: 0, bottom: 36 });
  assert.deepEqual(lay("a", { y: 0 }).block, { left: 16, top: -4, right: 21, bottom: 4 });
  assert.deepEqual(lay("a", { y: 1 }).block, { left: 16, top: 60, right: 21, bottom: 68 });
  // The largest type on the smallest frame: far wider than the frame, and Fit brings it to the room.
  const small = lay("aaaaaaaa", { size: 0.4, room: 0.1 }, { width: 16, height: 16 });
  near(small.lines[0]!.width, 1.6);
});

test("the rule sits under the last line, as long as the frame says and placed like a line", () => {
  const rule = { length: 0.5, weight: 0.125, gap: 0.25, soft: false };
  const left = lay("aa", { rule });
  assert.deepEqual(left.rule, { box: { left: 16, top: 36, right: 48, bottom: 37 }, color: [255, 255, 255], soft: false });
  assert.deepEqual(left.block, { left: 16, top: 28, right: 26, bottom: 36 });
  assert.deepEqual(left.bounds, { left: 16, top: 28, right: 48, bottom: 37 });
  assert.deepEqual(lay("aa", { rule, align: "center", x: 0.5 }).rule!.box, { left: 16, top: 36, right: 48, bottom: 37 });
  assert.deepEqual(lay("aa", { rule, align: "right", x: 1 }).rule!.box, { left: 32, top: 36, right: 64, bottom: 37 });
  // Switching a rule on never moves the words: the block is centred without it.
  assert.deepEqual(lay("a\na", { rule }).lines.map(line => line.baseline), lay("a\na").lines.map(line => line.baseline));
  assert.equal(lay("a\na", { rule }).rule!.box.top, 40);
  // A rule shorter than the words leaves the bounds to the words; a gap of nothing puts it on the baseline.
  const short = lay("aaaa", { rule: { length: 0.125, weight: 0.25, gap: 0, soft: true } });
  assert.deepEqual(short.rule, { box: { left: 16, top: 34, right: 24, bottom: 36 }, color: [255, 255, 255], soft: true });
  assert.deepEqual(short.bounds, short.block);
  // It takes the fill's colour: under a gradient, the colour half-way down a line.
  const graded = lay("a", { rule, fill: { kind: "gradient", stops: [{ at: 0, color: "#000000" }, { at: 1, color: "#ff8040" }] } });
  assert.deepEqual(graded.rule!.color, [127.5, 64, 32]);
});

test("a frame is whole pixels from 16 to 8192 each way, and refuses otherwise", () => {
  assert.deepEqual([TEXT_FRAME_MIN, TEXT_FRAME_MAX], [16, 8192]);
  const reason = "A text picture is 16 to 8192 whole pixels each way";
  for (const side of [15, 0, -64, 8193, 64.5, Number.NaN, Infinity]) {
    assert.equal(refusal("a", {}, { width: side, height: 64 }), reason, `width ${side}`);
    assert.equal(refusal("a", {}, { width: 64, height: side }), reason, `height ${side}`);
  }
  assert.equal(refusal("a", {}, { width: 16, height: 16 }), "laid out");
  assert.equal(refusal("a", {}, { width: 8192, height: 8192 }), "laid out");
  // The frame is asked first: a bad frame is the reason even when a character is missing too.
  assert.equal(refusal("z", {}, { width: 15, height: 64 }), reason);
  const { face } = proofFace();
  assert.deepEqual(layoutText("a", proofInk(), PROOF_FRAME, { ...face, unitsPerEm: 0 }), { ok: false, reason: "Proof cannot be measured" });
  assert.deepEqual(layoutText("a", proofInk(), PROOF_FRAME, { ...face, ascent: Number.NaN }), { ok: false, reason: "Proof cannot be measured" });
});

test("a face whose measures are not numbers refuses, whichever measure it is", () => {
  const { face } = proofFace(), unmeasured = { ok: false, reason: "Proof cannot be measured" };
  // Each of the face's own four, alone. A cap height that is not a number moves no line, only where a gradient begins.
  const measures: Partial<typeof face>[] = [
    { unitsPerEm: 0 }, { unitsPerEm: -8 }, { unitsPerEm: Number.NaN }, { ascent: Number.NaN }, { ascent: Infinity },
    { descent: Number.NaN }, { descent: Infinity }, { descent: -Infinity }, { capHeight: Number.NaN }, { capHeight: Infinity },
  ];
  for (const measure of measures) assert.deepEqual(layoutText("a", proofInk(), PROOF_FRAME, { ...face, ...measure }), unmeasured, Object.keys(measure).join());
  // And a face with sound measures whose shaping is not: an advance that is not a number is a line with no width.
  for (const advance of [Number.NaN, Infinity, -Infinity]) for (const align of ["left", "center", "right"] as const) {
    const broken = { ...face, shape: (line: string, options: { ligatures: boolean }) => face.shape(line, options).map(glyph => ({ ...glyph, advance })) };
    assert.deepEqual(layoutText("aa", proofInk({ align }), PROOF_FRAME, broken), unmeasured, `advance ${advance}, ${align}`);
  }
});

test("a fill's colour runs straight between its stops, and two stops at one place are a step", () => {
  assert.deepEqual(textRgb("#1a2B3c"), [26, 43, 60]);
  assert.deepEqual(textFillAt({ kind: "solid", color: "#102030" }, 0.7), [16, 32, 48]);
  const two = { kind: "gradient" as const, stops: [{ at: 0, color: "#000000" }, { at: 1, color: "#ff8040" }] };
  assert.deepEqual(textFillAt(two, 0), [0, 0, 0]);
  assert.deepEqual(textFillAt(two, 0.25), [63.75, 32, 16]);
  assert.deepEqual(textFillAt(two, 0.5), [127.5, 64, 32]);
  assert.deepEqual(textFillAt(two, 1), [255, 128, 64]);
  // Stops are read in order of place however they were typed, and the ends hold beyond the stops.
  const inset = { kind: "gradient" as const, stops: [{ at: 0.75, color: "#0000ff" }, { at: 0.25, color: "#ff0000" }] };
  assert.deepEqual(textFillAt(inset, 0), [255, 0, 0]);
  assert.deepEqual(textFillAt(inset, 0.25), [255, 0, 0]);
  assert.deepEqual(textFillAt(inset, 0.5), [127.5, 0, 127.5]);
  assert.deepEqual(textFillAt(inset, 0.75), [0, 0, 255]);
  assert.deepEqual(textFillAt(inset, 1), [0, 0, 255]);
  assert.deepEqual(inset.stops.map(stop => stop.at), [0.75, 0.25]);
  // A hard step: the earlier colour up to the place, the later one at it and after.
  const step = { kind: "gradient" as const, stops: [{ at: 0, color: "#000000" }, { at: 0.5, color: "#640000" }, { at: 0.5, color: "#0000c8" }, { at: 1, color: "#0000ff" }] };
  assert.deepEqual(textFillAt(step, 0.25), [50, 0, 0]);
  assert.deepEqual(textFillAt(step, 0.5), [0, 0, 200]);
  assert.deepEqual(textFillAt(step, 0.75), [0, 0, 227.5]);
  const before = textFillAt(step, 0.4999);
  assert.ok(before[0] > 99.9 && before[2] === 0);
  // The order typed decides which side of the step a colour is on.
  const turned = { kind: "gradient" as const, stops: [step.stops[0]!, step.stops[2]!, step.stops[1]!, step.stops[3]!] };
  assert.deepEqual(textFillAt(turned, 0.5), [100, 0, 0]);
});
