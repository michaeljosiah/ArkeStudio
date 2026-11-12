import assert from "node:assert/strict";
import { test } from "node:test";
import { TEXT_LABEL_LIMIT, TEXT_MAX_CHARACTERS, TEXT_MAX_LINES, TextLookSchema, textLabel, textWords, type TextLook } from "../src/editor-text.js";
import { TEXT_PAINTER_VERSION, TEXT_TYPEFACES, TEXT_TYPEFACE_IDS, textTypefaceFile, textTypefaceStyle } from "../src/editor-text-typefaces.js";

// The record a text clip stores (SPEC-065 §2.1). A limit refuses; nothing is ever cut or clamped to fit.

const look = (): TextLook => ({
  typeface: "geist", weight: "regular", italic: false, size: 0.07, tracking: 0.02, leading: 1.1, capitals: false, align: "center", x: 0.5, y: 0.8, room: 0.9,
  fill: { kind: "gradient", stops: [{ at: 0, color: "#fff4c8" }, { at: 1, color: "#b98a2e" }] },
  edge: { color: "#1a1208", width: 0.02 },
  shadow: { color: "#000000", opacity: 0.8, blur: 0.25, dx: 0, dy: 0.03 },
  rule: { length: 0.2, weight: 0.02, gap: 0.3, soft: true },
  backing: { kind: "shade", color: "#000000", opacity: 0.5 },
});
/** The look with one value replaced, by a path like "shadow.blur". */
function changed(path: string, value: unknown): unknown {
  const copy = structuredClone(look()) as unknown as Record<string, unknown>, keys = path.split(".");
  let at = copy;
  for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>;
  at[keys[keys.length - 1]!] = value;
  return copy;
}

test("the words keep what was typed and refuse past 500 characters or 12 lines (SPEC-065 R-4)", () => {
  assert.equal(TEXT_MAX_CHARACTERS, 500);
  assert.equal(TEXT_MAX_LINES, 12);
  assert.deepEqual(textWords("a".repeat(500)), { ok: true, text: "a".repeat(500) });
  assert.deepEqual(textWords("a".repeat(501)), { ok: false, reason: "Text holds at most 500 characters" });
  // A line end is a character of the words: 250 + 1 + 249 is the limit, and one more is over it.
  assert.equal(textWords(`${"a".repeat(250)}\n${"a".repeat(249)}`).ok, true);
  assert.deepEqual(textWords(`${"a".repeat(250)}\n${"a".repeat(250)}`), { ok: false, reason: "Text holds at most 500 characters" });
  const twelve = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
  assert.deepEqual(textWords(twelve), { ok: true, text: twelve });
  assert.deepEqual(textWords(`${twelve}\nline 12`), { ok: false, reason: "Text holds at most 12 lines" });
  // Thirteen lines are thirteen whether or not the inner ones hold anything.
  assert.deepEqual(textWords(`first${"\n".repeat(12)}last`), { ok: false, reason: "Text holds at most 12 lines" });
});

test("only blank lines refuse; blank lines at the ends go and the ones inside stay", () => {
  for (const blank of ["", "   ", "\n\n", " \n\t\n  ", "\r\n\r\n"]) assert.deepEqual(textWords(blank), { ok: false, reason: "Type some words" });
  assert.deepEqual(textWords("\n\n  \nTHE RED QUIET\n\n\na film\n \n\n"), { ok: true, text: "THE RED QUIET\n\n\na film" });
  // Only whole blank lines are dropped: the spaces typed on a kept line are part of the words.
  assert.deepEqual(textWords("\n  two  spaces  \n"), { ok: true, text: "  two  spaces  " });
  // Twelve lines of words inside a frame of blank ones are still twelve.
  const twelve = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
  assert.deepEqual(textWords(`\n\n${twelve}\n\n`), { ok: true, text: twelve });
});

test("every kind of line end is stored as a line feed", () => {
  assert.deepEqual(textWords("one\r\ntwo\rthree\nfour"), { ok: true, text: "one\ntwo\nthree\nfour" });
  assert.deepEqual(textWords("one\r\n\r\ntwo"), { ok: true, text: "one\n\ntwo" });
  // A Windows line end is one character once stored, so 500 characters typed on Windows still fit.
  assert.equal(textWords(`${"a".repeat(250)}\r\n${"a".repeat(249)}`).ok, true);
});

test("the label is the first line, trimmed and cut to whole characters (SPEC-065 R-6)", () => {
  assert.equal(textLabel("  THE RED QUIET  \na film"), "THE RED QUIET");
  assert.equal(textLabel(""), "Text");
  assert.equal(textLabel("   \nsecond"), "Text");
  assert.equal(TEXT_LABEL_LIMIT, 80);
  assert.equal(textLabel("a".repeat(81)), "a".repeat(80));
  // A character outside the basic plane is two code units and one character: 80 of them survive whole.
  const label = textLabel("\u{1F600}".repeat(81));
  assert.equal([...label].length, 80);
  assert.equal(label, "\u{1F600}".repeat(80));
});

test("a look parses as it was written and refuses a field it does not know", () => {
  assert.deepEqual(TextLookSchema.parse(look()), look());
  const plain = { ...look() };
  delete plain.edge; delete plain.shadow; delete plain.rule; delete plain.backing;
  assert.deepEqual(TextLookSchema.parse(plain), plain);
  assert.equal(TextLookSchema.safeParse({ ...look(), glow: 1 }).success, false);
  for (const path of ["edge.join", "shadow.spread", "rule.color", "backing.radius"]) assert.equal(TextLookSchema.safeParse(changed(path, 1)).success, false, path);
  assert.equal(TextLookSchema.safeParse(changed("fill", { kind: "solid", color: "#ffffff", stops: [] })).success, false);
  assert.equal(TextLookSchema.safeParse(changed("fill", { kind: "gradient", stops: [{ at: 0, color: "#ffffff", ease: 1 }, { at: 1, color: "#000000" }] })).success, false);
  // The gradient itself, not only its stops: an angle nobody drew would ride into the picture's name.
  const gradient = { kind: "gradient", stops: [{ at: 0, color: "#ffffff" }, { at: 1, color: "#000000" }] };
  assert.equal(TextLookSchema.safeParse(changed("fill", gradient)).success, true);
  assert.equal(TextLookSchema.safeParse(changed("fill", { ...gradient, angle: 90 })).success, false);
});

test("each number refuses just outside its range and is never clamped into it", () => {
  const ranges: [string, number, number][] = [
    ["size", 0.01, 0.4], ["tracking", -0.05, 0.5], ["leading", 0.8, 2], ["x", 0, 1], ["y", 0, 1], ["room", 0.1, 1],
    ["edge.width", 0.005, 0.2],
    ["shadow.opacity", 0, 1], ["shadow.blur", 0, 1], ["shadow.dx", -1, 1], ["shadow.dy", -1, 1],
    ["rule.length", 0.02, 1], ["rule.weight", 0.005, 0.2], ["rule.gap", 0, 2],
    ["backing.opacity", 0, 1],
  ];
  const read = (value: unknown, path: string) => path.split(".").reduce<unknown>((at, key) => (at as Record<string, unknown>)[key], value);
  for (const [path, low, high] of ranges) {
    for (const edge of [low, high]) {
      const parsed = TextLookSchema.safeParse(changed(path, edge));
      assert.equal(parsed.success, true, `${path} ${edge}`);
      // The value comes back as it went in: a parse that moved it would be a clamp by another name.
      if (parsed.success) assert.equal(read(parsed.data, path), edge, `${path} ${edge}`);
    }
    for (const outside of [low - 0.001, high + 0.001, Number.NaN, Infinity]) assert.equal(TextLookSchema.safeParse(changed(path, outside)).success, false, `${path} ${outside}`);
  }
});

test("a look refuses a colour, a stop or a choice it cannot draw", () => {
  for (const color of ["#fff", "ffffff", "#gggggg", "red", "#ffffff80"]) {
    assert.equal(TextLookSchema.safeParse(changed("fill", { kind: "solid", color })).success, false, color);
    assert.equal(TextLookSchema.safeParse(changed("edge.color", color)).success, false, color);
  }
  const stop = (at: number) => ({ at, color: "#ffffff" });
  assert.equal(TextLookSchema.safeParse(changed("fill", { kind: "gradient", stops: [stop(0)] })).success, false);
  assert.equal(TextLookSchema.safeParse(changed("fill", { kind: "gradient", stops: [stop(0), stop(0.25), stop(0.5), stop(0.75), stop(1)] })).success, false);
  assert.equal(TextLookSchema.safeParse(changed("fill", { kind: "gradient", stops: [stop(0), stop(0.25), stop(0.5), stop(1)] })).success, true);
  // Two stops at one place are a hard step, not a mistake.
  assert.equal(TextLookSchema.safeParse(changed("fill", { kind: "gradient", stops: [stop(0.5), stop(0.5)] })).success, true);
  assert.equal(TextLookSchema.safeParse(changed("fill", { kind: "gradient", stops: [stop(-0.01), stop(1)] })).success, false);
  assert.equal(TextLookSchema.safeParse(changed("fill", { kind: "gradient", stops: [stop(0), stop(1.01)] })).success, false);
  for (const [path, value] of [["align", "justify"], ["backing.kind", "pill"], ["weight", "black"], ["typeface", "arial"], ["capitals", "yes"], ["italic", 1], ["rule.soft", "yes"]] as const) {
    assert.equal(TextLookSchema.safeParse(changed(path, value)).success, false, path);
  }
});

test("a weight or slant the face lacks refuses by name and is never made from the one it has (SPEC-065 R-7)", () => {
  assert.deepEqual(TEXT_TYPEFACE_IDS, ["geist", "jost", "comic-neue", "bangers", "eb-garamond", "cinzel"]);
  // What each face has, as its publisher draws it: R-7 asks for no more than these.
  assert.deepEqual(Object.fromEntries(TEXT_TYPEFACE_IDS.map(id => [id, Object.keys(TEXT_TYPEFACES[id].files)])), {
    geist: ["regular", "bold"], jost: ["regular", "bold", "italic", "bold-italic"], "comic-neue": ["regular", "bold", "italic", "bold-italic"],
    bangers: ["regular"], "eb-garamond": ["regular", "bold", "italic", "bold-italic"], cinzel: ["regular", "bold"],
  });
  assert.deepEqual(TEXT_TYPEFACE_IDS.map(id => TEXT_TYPEFACES[id].name), ["Geist", "Jost", "Comic Neue", "Bangers", "EB Garamond", "Cinzel"]);
  for (const id of TEXT_TYPEFACE_IDS) assert.equal(TEXT_TYPEFACES[id].id, id);
  const regular = textTypefaceFile("geist", "regular", false);
  assert.equal(regular.ok, true);
  if (regular.ok) {
    assert.equal(regular.style, "regular");
    assert.equal(regular.typeface.name, "Geist");
    assert.equal(regular.file, TEXT_TYPEFACES.geist.files.regular);
    assert.match(regular.file.sha256, /^[0-9a-f]{64}$/);
  }
  const bold = textTypefaceFile("geist", "bold", false);
  assert.ok(bold.ok && bold.style === "bold" && bold.file === TEXT_TYPEFACES.geist.files.bold);
  assert.deepEqual(textTypefaceFile("geist", "regular", true), { ok: false, reason: "Geist has no italic" });
  // A bold that has no italic beside it: one refusal names one thing, the slant.
  assert.deepEqual(textTypefaceFile("geist", "bold", true), { ok: false, reason: "Geist has no italic" });
  assert.deepEqual(textTypefaceFile("cinzel", "bold", true), { ok: false, reason: "Cinzel has no italic" });
  // With neither, the slant again; with an italic and no bold, the weight.
  assert.deepEqual(textTypefaceFile("bangers", "bold", false), { ok: false, reason: "Bangers has no bold" });
  assert.deepEqual(textTypefaceFile("bangers", "regular", true), { ok: false, reason: "Bangers has no italic" });
  assert.deepEqual(textTypefaceFile("bangers", "bold", true), { ok: false, reason: "Bangers has no italic" });
  for (const id of ["jost", "comic-neue", "eb-garamond"] as const) for (const weight of ["regular", "bold"] as const) for (const italic of [false, true]) {
    const choice = textTypefaceFile(id, weight, italic);
    assert.ok(choice.ok && choice.file === TEXT_TYPEFACES[id].files[textTypefaceStyle(weight, italic)], `${id} ${weight} ${italic}`);
  }
  assert.equal(textTypefaceStyle("regular", false), "regular");
  assert.equal(textTypefaceStyle("bold", false), "bold");
  assert.equal(textTypefaceStyle("regular", true), "italic");
  assert.equal(textTypefaceStyle("bold", true), "bold-italic");
  // Every style a face lists is one of its files, so a choice that resolves always has bytes behind it.
  for (const id of TEXT_TYPEFACE_IDS) for (const file of Object.values(TEXT_TYPEFACES[id].files)) assert.match(file.file, /\.(ttf|otf)$/);
  // One file is never two styles: a typing slip that pointed bold at the regular file would draw a bold that is not one.
  const files = TEXT_TYPEFACE_IDS.flatMap(id => Object.values(TEXT_TYPEFACES[id].files));
  assert.equal(new Set(files.map(file => file.file)).size, files.length);
  assert.equal(new Set(files.map(file => file.sha256)).size, files.length);
  // Each face names its own licence text, the one its files are kept beside under its publisher's prefix.
  for (const id of TEXT_TYPEFACE_IDS) {
    const { licence, files: own } = TEXT_TYPEFACES[id], prefix = licence.replace(/-OFL\.txt$/, "-");
    assert.notEqual(prefix, licence, `${id}'s licence is an OFL text`);
    for (const { file } of Object.values(own)) assert.ok(file.startsWith(prefix), `${file} sits beside ${licence}`);
  }
  assert.equal(TEXT_PAINTER_VERSION, "text-painter-v1");
});
