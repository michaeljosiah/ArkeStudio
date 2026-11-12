import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TEXT_TYPEFACES, textDisplayLines, textTypefaceFile, type TextFace } from "@arke-studio/contracts";
import { loadTextFace, loadTextFaceFile, textFaceFromBytes } from "../../src/media/text-typefaces.js";
import { tempDir } from "../tmp.js";

const fonts = fileURLToPath(new URL("../../src/publications/fonts/", import.meta.url));
const sha256 = (file: string) => createHash("sha256").update(readFileSync(join(fonts, file))).digest("hex");
const face = (load: ReturnType<typeof loadTextFaceFile>): TextFace => { assert.ok(load.ok, load.ok ? "" : load.reason); return load.face; };
const geist = () => face(loadTextFace("geist", "regular", false));
// DejaVu Serif is not a text typeface; it stands in here for a face with an `fi` ligature and a kern table.
const serif = () => face(loadTextFaceFile("DejaVuSerif.ttf", sha256("DejaVuSerif.ttf"), "DejaVu Serif"));
/** Every character of the Latin blocks a title is typed from, as far as the face has them. */
const everyLetter = (of: TextFace) => {
  let line = "";
  for (const [from, to] of [[0x20, 0x24f], [0x1e00, 0x1eff], [0x2010, 0x2044]] as const)
    for (let codePoint = from; codePoint <= to; codePoint++) if (of.has(codePoint)) line += String.fromCodePoint(codePoint);
  return line;
};

it("ships every text typeface file at its recorded hash, with its licence beside it (SPEC-065 R-22)", () => {
  for (const typeface of Object.values(TEXT_TYPEFACES)) {
    assert.ok(existsSync(join(fonts, typeface.licence)), `${typeface.licence} is beside the ${typeface.name} files`);
    for (const { file, sha256: recorded } of Object.values(typeface.files)) {
      assert.ok(existsSync(join(fonts, file)), `${file} is in the fonts folder`);
      assert.equal(sha256(file), recorded, `${file} is the file the table records`);
    }
  }
  // The packaging check reads every entry of this folder as a file, and the source-text check
  // lets only a `.ttf` directly inside it hold binary.
  for (const entry of readdirSync(fonts, { withFileTypes: true }))
    assert.ok(entry.isFile() && /^(?:[\w-]+\.(?:ttf|txt|md)|LICENSE)$/.test(entry.name), `${entry.name} is a font file or a text, directly in the folder`);
});

it("reads Geist's measures from the file itself", () => {
  const bytes = readFileSync(join(fonts, "Geist-Regular.ttf")), font = geist();
  // The `hhea` table, found by hand: what the file says, whatever the parser makes of it.
  let hhea = -1;
  for (let table = 0; table < bytes.readUInt16BE(4); table++)
    if (bytes.toString("latin1", 12 + table * 16, 16 + table * 16) === "hhea") hhea = bytes.readUInt32BE(20 + table * 16);
  assert.ok(hhea > 0);
  assert.deepEqual([font.name, font.unitsPerEm, font.ascent, font.descent], ["Geist", 1000, bytes.readInt16BE(hhea + 4), bytes.readInt16BE(hhea + 6)]);
  assert.deepEqual([font.ascent, font.descent], [1005, -295]);
  assert.ok(font.capHeight / font.unitsPerEm > 0.6 && font.capHeight / font.unitsPerEm < 0.8, `cap height ${font.capHeight}`);
  assert.deepEqual([0xe9, 0x1eb9, 0x1e63].map(codePoint => font.has(codePoint)), [true, true, false]);
});

it("kerns, and leaves ligatures out when asked without losing the kerning", () => {
  for (const font of [geist(), serif()]) {
    const alone = font.shape("A", { ligatures: true })[0]!.advance;
    for (const ligatures of [true, false]) {
      const pair = font.shape("AV", { ligatures });
      assert.deepEqual(pair.map(glyph => glyph.codePoints), [[0x41], [0x56]]);
      assert.ok(pair[0]!.advance < alone, `${font.name} draws AV closer than A's own ${alone}, ligatures ${ligatures}`);
    }
    assert.deepEqual(font.shape("fi", { ligatures: true }).map(glyph => glyph.codePoints), [[0x66, 0x69]]);
    assert.deepEqual(font.shape("fi", { ligatures: false }).map(glyph => glyph.codePoints), [[0x66], [0x69]]);
  }
  // Geist kerns the very pair it would have joined.
  assert.ok(geist().shape("fi", { ligatures: false })[0]!.advance < geist().shape("f", { ligatures: false })[0]!.advance);
});

it("shapes a combining mark as its own glyph with no advance", () => {
  const name = "Ifẹ́".normalize("NFC");
  assert.equal(name, "Ifẹ́", "NFC has no single character for the dotted e with an acute");
  for (const font of [serif(), geist()]) for (const ligatures of [true, false]) {
    const glyphs = font.shape(name, { ligatures });
    assert.deepEqual(glyphs.map(glyph => glyph.codePoints), [[0x49], [0x66], [0x1eb9], [0x301]]);
    assert.deepEqual(glyphs.map(glyph => glyph.mark), [false, false, false, true]);
    assert.equal(glyphs[3]!.advance, 0);
    assert.ok(glyphs[3]!.outline.length > 0 && glyphs[2]!.advance > 0);
  }
  // Where the mark goes is the face's to say, in its own units: back over its letter, and up when the letter is a capital.
  // A y that grows upward is what the painter is promised; a mark that sank into its capital would be a sign read the other way.
  const placed = (line: string) => { const mark = geist().shape(line, { ligatures: true })[3]!; return [mark.mark, mark.dx, mark.dy]; };
  assert.deepEqual(placed(name), [true, -355, -2]);
  assert.deepEqual(placed(textDisplayLines(name, true)[0]!), [true, -367, 180]);
});

it("Capitals makes of every character Geist has what it made when the pictures were pinned (R-19)", () => {
  // Capitals is String.prototype.toUpperCase, which reads the Unicode tables of the Node it runs
  // on. A newer Node may give a letter a capital it did not have, and the same clip would then
  // paint differently, or refuse, under one painter version and one name. This is every character
  // of the face and what Capitals makes of it, as one hash: when a Node moves any of them this
  // fails, and that Node is not taken until the painter's version is raised with it.
  const hash = createHash("sha256"), lost: number[] = [], font = geist();
  let had = 0, longer = 0;
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
    if ((codePoint >= 0xd800 && codePoint <= 0xdfff) || !font.has(codePoint)) continue;
    had++;
    const capitals = [...textDisplayLines(String.fromCodePoint(codePoint), true)[0]!].map(character => character.codePointAt(0)!);
    if (capitals.length > 1) longer++;
    if (!capitals.every(capital => font.has(capital))) lost.push(codePoint);
    hash.update(`${codePoint.toString(16)}:${capitals.map(capital => capital.toString(16)).join("+")}\n`);
  }
  assert.deepEqual([had, longer], [728, 3]);
  // The micro sign, the florin, mu and pi: Geist has the small letter and not its capital, so Capitals refuses a line that holds one.
  assert.deepEqual(lost, [0xb5, 0x192, 0x3bc, 0x3c0]);
  assert.equal(hash.digest("hex"), "13c1399530feac1579f2cc79d101cc34c1ddef737d5280874e576b2c0246418c", `Capitals on Unicode ${process.versions.unicode}`);
});

it("hands over outlines of five commands and finite numbers only", () => {
  const takes = { moveTo: 2, lineTo: 2, quadraticCurveTo: 4, bezierCurveTo: 6, closePath: 0 };
  for (const font of [geist(), serif()]) {
    const line = everyLetter(font);
    assert.ok(line.length > 400, `${font.name} has ${line.length} of the characters`);
    let commands = 0;
    for (const ligatures of [true, false]) for (const glyph of font.shape(line, { ligatures })) {
      assert.ok([glyph.advance, glyph.dx, glyph.dy].every(Number.isFinite) && glyph.codePoints.length > 0 && typeof glyph.mark === "boolean");
      for (const { command, args } of glyph.outline) {
        assert.equal(args.length, takes[command], `${command} for U+${glyph.codePoints[0]!.toString(16)} in ${font.name}`);
        assert.ok(args.every(Number.isFinite));
        commands++;
      }
    }
    assert.ok(commands > 10_000);
  }
});

it("shapes the same line the same way every time", () => {
  // Digits and a slash: a feature left switched on by an earlier line would turn them into a fraction.
  const line = "The office of Ifẹ́ AVA 1/2 To: 12";
  for (const font of [geist(), serif()]) {
    const joined = font.shape(line, { ligatures: true }), apart = font.shape(line, { ligatures: false });
    assert.ok(apart.length > joined.length);
    assert.deepEqual(font.shape(line, { ligatures: false }), apart);
    assert.deepEqual(font.shape(line, { ligatures: true }), joined);
    assert.deepEqual(font.shape("12", { ligatures: false }).map(glyph => glyph.advance), font.shape("12", { ligatures: true }).map(glyph => glyph.advance));
  }
  // A second reading of the same bytes agrees with the first, glyph for glyph.
  const again = textFaceFromBytes(readFileSync(join(fonts, "Geist-Regular.ttf")), "Geist");
  assert.deepEqual(again.shape(line, { ligatures: false }), geist().shape(line, { ligatures: false }));
  assert.deepEqual([again.unitsPerEm, again.ascent, again.descent, again.capHeight], [geist().unitsPerEm, geist().ascent, geist().descent, geist().capHeight]);
  // fontkit keeps a glyph under the characters of whoever asked for it first. A dotted e is drawn
  // from an e and a dot, asked for with none; a space and a no-break space are one glyph.
  for (const font of [again, serif()]) {
    font.shape("ẹ", { ligatures: true });
    const parts = font.shape("ẹ", { ligatures: true });
    assert.deepEqual([parts.map(glyph => glyph.codePoints), parts.map(glyph => glyph.mark)], [[[0x65], [0x323]], [false, true]]);
    assert.deepEqual(font.shape("   ", { ligatures: true }).map(glyph => glyph.codePoints), [[0xa0], [0x20], [0xa0]]);
  }
});

it("refuses a missing or changed file by the file's name, and a missing weight in the table's words (R-7, R-21)", () => {
  const recorded = TEXT_TYPEFACES.geist.files.regular.sha256;
  assert.deepEqual(loadTextFaceFile("Geist-Regular.ttf", "0".repeat(64), "Geist"), { ok: false, reason: "Geist-Regular.ttf is not the file this app shipped with" });
  assert.deepEqual(loadTextFaceFile("Geist-Bold.ttf", recorded, "Geist"), { ok: false, reason: "Geist-Bold.ttf is missing" });
  for (const [weight, italic] of [["bold", false], ["regular", true], ["bold", true]] as const) {
    const refusal = textTypefaceFile("geist", weight, italic);
    assert.ok(!refusal.ok && refusal.reason.startsWith("Geist has no "));
    assert.deepEqual(loadTextFace("geist", weight, italic), refusal);
  }
});

it("finds the file beside the packaged bundle and reads it once", async () => {
  // `dist/main.cjs` with `dist/fonts` beside it, as apps/desktop/scripts/build.mjs lays the bundle out.
  const dist = join(await tempDir("arke-text-face-"), "dist"), bundle = pathToFileURL(join(dist, "main.cjs")).href;
  const { file, sha256: recorded } = TEXT_TYPEFACES.geist.files.regular;
  assert.deepEqual(loadTextFace("geist", "regular", false, bundle), { ok: false, reason: `${file} is missing` });
  await mkdir(join(dist, "fonts"), { recursive: true });
  await cp(join(fonts, file), join(dist, "fonts", file));
  const first = face(loadTextFace("geist", "regular", false, bundle));
  assert.deepEqual(first.shape("AV", { ligatures: true }), geist().shape("AV", { ligatures: true }));
  assert.notEqual(first, geist(), "the bundle's file is its own reading, not the source folder's");
  // With the file gone, only a kept face can answer.
  await rm(join(dist, "fonts", file));
  assert.equal(face(loadTextFace("geist", "regular", false, bundle)), first);
  assert.equal(face(loadTextFaceFile(file, recorded, "Geist", bundle)), first);
  assert.deepEqual(loadTextFaceFile(file, "0".repeat(64), "Geist", bundle), { ok: false, reason: `${file} is missing` });
  assert.equal(geist(), geist());
});
