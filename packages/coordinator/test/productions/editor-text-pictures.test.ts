import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TEXT_PAINTER_VERSION, TEXT_TYPEFACES, TextLookSchema, canonicalJson, layoutText, type TextLook } from "@arke-studio/contracts";
import { loadTextFace } from "../../src/media/text-typefaces.js";
import { paintTextPicture, textPictureName, textPicturePng, type TextPicturePaint } from "../../src/productions/editor-text-pictures.js";
import { decodePng } from "../../src/references/png.js";
import { PROOF_CARDS, PROOF_NAMES, PROOF_NAME_BASELINE, PROOF_NAME_FRAME, paintProofName, proofSerif } from "../../../../scripts/text-painter-proof.mjs";
import { tempDir } from "../tmp.js";

// The painter with the files it ships with (SPEC-065 R-18 – R-23): the pictures the proof script
// writes for a person to look at, pinned here by their pixels. A PNG file is never pinned; two
// builds of zlib may pack the same pixels differently.

type Painted = Extract<TextPicturePaint, { ok: true }>;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length));
function paint(ask: Parameters<typeof paintTextPicture>[0], from?: string): Painted {
  const picture = paintTextPicture(ask, from);
  if (!picture.ok) throw new Error(picture.reason);
  return picture;
}
const card = (slug: string) => {
  const { text, look, width, height } = PROOF_CARDS.find(found => found.slug === slug)!;
  return { text, look, width, height };
};
const { file: GEIST_FILE, sha256: GEIST_SHA256 } = TEXT_TYPEFACES.geist.files.regular;
const fonts = fileURLToPath(new URL("../../src/publications/fonts/", import.meta.url));
/** `dist/main.cjs` with `dist/fonts` beside it, as the packaged app is laid out, holding `bytes` as Geist — or no fonts at all. */
async function bundle(bytes?: Uint8Array): Promise<string> {
  const dist = join(await tempDir("arke-text-picture-"), "dist");
  if (bytes) {
    await mkdir(join(dist, "fonts"), { recursive: true });
    await writeFile(join(dist, "fonts", GEIST_FILE), bytes);
  }
  return pathToFileURL(join(dist, "main.cjs")).href;
}

// SHA-256 over the raw RGBA of each picture. These move only when ink moves, and ink that moves
// raises TEXT_PAINTER_VERSION (R-23): change the version and this table together, never one alone.
const PAINTER = "text-painter-v2";
const NAME_PIXELS: Record<(typeof PROOF_NAMES)[number]["slug"], string> = {
  ade: "3864e59de7876c65acf3149da3843146920779a20987d7c42db5a1fdcd6714c0",
  tunde: "a2c2e597cc8f3b4ffe8dcdbf6ebba778bb25706176b8674b087109022a4f0603",
  ife: "6b672af343de425f7fe733efa43fa2ed73c70368b2fe0dbd2be728475a4b847d",
  lady: "3e4cfbc8fe8a0bf65eca53327403c231a0c3eb291b774baf300913b51a3482eb",
};
const CARD_PIXELS: Record<string, string> = {
  block: "79fe307acd5e53e3d18b079911f71707484ac1a61044b94d629b0c9e44c13131",
  capitals: "4b76503f78320b9cf9d36a1d2c8c4c054bb294fd5087a19ae4689c4362728a00",
  fit: "a87ff7e12529b01b6341b775fa7a6c1a380d2e16d2f4e879a91a0e8e99decabb",
  overhang: "4df04137f8fb89d2ed76b5c0a84aca8272ebe2182f55524dc06cf279515fd8eb",
  wide: "084569ef24488c10738de555a6c1370c81de7388535bc76824bc1d553bee0e96",
};
/** The capitals card on a frame of odd sides, where no length of the look lands on a whole pixel. */
const SMALL = { ...card("capitals"), width: 321, height: 181 };
const SMALL_PIXELS = "50a3227843abfea703da5656a3664b268a8950c6ab191b2972997c7517e62738";
/** A dotted capital E with an acute, in capitals: the one mark Geist lifts, by 180 of its 1000 units, to clear a capital. */
const LIFTED = { text: String.fromCodePoint(0x49, 0x66, 0x1eb9, 0x301), look: TextLookSchema.parse({ typeface: "geist", weight: "regular", italic: false, size: 0.4, tracking: 0, leading: 1.2, capitals: true, align: "center", x: 0.5, y: 0.5, room: 0.9, fill: { kind: "solid", color: "#ffffff" } }), width: 320, height: 180 };
const LIFTED_PIXELS = "bf1181eee075c474bc7fdbd5a5b7675fad9e04b5760458b78eb1c3e71819cf17";

it("paints the promo's four names in a real serif to the same pixels every time (R-19, R-23)", () => {
  assert.equal(TEXT_PAINTER_VERSION, PAINTER, "the painter's version and the pictures pinned here change together");
  for (const { slug, text } of PROOF_NAMES) {
    const { ink, picture } = paintProofName(text);
    assert.deepEqual([picture.width, picture.height, picture.rgba.length], [1080, 1920, 1080 * 1920 * 4]);
    assert.equal(sha256(picture.rgba), NAME_PIXELS[slug], `${text} at 1080x1920`);
    const laid = layoutText(text, ink, PROOF_NAME_FRAME, proofSerif());
    assert.ok(laid.ok && Math.abs(laid.layout.lines[0]!.baseline - PROOF_NAME_BASELINE) < 1e-9, `${text} stands on row ${PROOF_NAME_BASELINE}`);
  }
});

it("paints the shipped typeface to the same pixels every time, tall, wide and small (R-19, R-23)", () => {
  assert.equal(TEXT_PAINTER_VERSION, PAINTER);
  for (const { slug, text, look, width, height } of PROOF_CARDS) {
    // The proof draws nothing a clip could not store.
    assert.deepEqual(TextLookSchema.parse(look), look);
    const picture = paint({ text, look, width, height });
    assert.deepEqual([picture.width, picture.height, picture.rgba.length], [width, height, width * height * 4]);
    assert.equal(sha256(picture.rgba), CARD_PIXELS[slug], `${slug} at ${width}x${height}`);
  }
  assert.deepEqual([card("wide").width, card("wide").height], [1920, 1080]);
  assert.equal(sha256(paint(SMALL).rgba), SMALL_PIXELS, "capitals at 321x181");
});

it("lifts a mark clear of its capital, by as much as the face says and upward (R-19)", () => {
  const { look } = LIFTED, face = loadTextFace("geist", "regular", false);
  assert.ok(face.ok);
  const laid = layoutText(LIFTED.text, look, LIFTED, face.face);
  assert.ok(laid.ok);
  const line = laid.layout.lines[0]!, mark = line.glyphs[3]!, { unit } = laid.layout;
  assert.deepEqual([line.text, mark.glyph.mark, mark.glyph.dy], ["IF" + String.fromCodePoint(0x1eb8, 0x301), true, 180]);
  // The acute's own outline, in the face's units above its origin: drawn for a small letter, it starts below the cap line.
  let low = Infinity, high = -Infinity;
  for (const { args } of mark.glyph.outline) for (let at = 1; at < args.length; at += 2) { low = Math.min(low, args[at]!); high = Math.max(high, args[at]!); }
  assert.deepEqual([low, high], [598, 726]);
  assert.ok(low < face.face.capHeight && low + mark.glyph.dy > face.face.capHeight);

  const picture = paint(LIFTED), inked: number[] = [];
  for (let y = 0; y < picture.height; y++) for (let x = 0; x < picture.width; x++) if (picture.rgba[(y * picture.width + x) * 4 + 3]) { inked.push(y); break; }
  // Lifted, the mark runs from 906 units above the baseline down to 778, and the capitals begin at 710: rows of nothing lie between.
  const top = Math.floor(line.baseline - (high + 180) * unit), foot = Math.ceil(line.baseline - (low + 180) * unit), cap = Math.floor(line.capLine);
  assert.deepEqual([top, foot, cap], [50, 60, 64]);
  assert.equal(inked[0], top, "the mark's top is the first row with ink");
  assert.deepEqual(inked.filter(y => y < cap), [50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
  // Without the mark the picture begins at the cap line.
  const bare = paint({ ...LIFTED, text: "If" + String.fromCodePoint(0x1eb9) });
  assert.equal(Math.floor((bare.rgba.findIndex(value => value > 0) >> 2) / bare.width), cap);
  assert.equal(sha256(picture.rgba), LIFTED_PIXELS, "a lifted mark at 320x180");
});

it("comes back from a PNG with every pixel it went in with", () => {
  for (const picture of [paintProofName("Ade").picture, paint(SMALL), paint(card("wide"))]) {
    const read = decodePng(textPicturePng(picture));
    assert.deepEqual([read.width, read.height], [picture.width, picture.height]);
    assert.ok(same(read.pixels, picture.rgba));
  }
});

it("names a picture by everything that decides a pixel, and by nothing else (R-20, §2.3)", () => {
  const ask = card("block"), named = { ...ask, fileSha256: GEIST_SHA256 }, name = textPictureName(named);
  assert.match(name, /^[0-9a-f]{64}$/);
  assert.equal(textPictureName({ ...named, look: structuredClone(ask.look) }), name);
  assert.equal(paint(ask).name, name, "the painter names its picture by the file it read");
  assert.equal(paint(ask).name, name);
  // The same look typed in another order is the same picture.
  assert.equal(textPictureName({ ...named, look: Object.fromEntries(Object.entries(ask.look).reverse()) as TextLook }), name);

  const changed: Array<[string, Partial<typeof named>]> = [
    ["a word", { text: ask.text.replace("Lagos", "Ibadan") }],
    ["a letter's case", { text: ask.text.toLowerCase() }],
    ["a line break", { text: ask.text.replace("\n", " ") }],
    ["the size", { look: { ...ask.look, size: ask.look.size + 0.001 } }],
    ["the fill", { look: { ...ask.look, fill: { kind: "solid", color: "#fffffe" } } }],
    ["the backing's opacity", { look: { ...ask.look, backing: { ...ask.look.backing!, opacity: 0.81 } } }],
    ["no backing", { look: (({ backing: _backing, ...rest }) => rest)(ask.look) }],
    ["capitals", { look: { ...ask.look, capitals: true } }],
    ["the width", { width: ask.width + 1 }],
    ["the height", { height: ask.height - 1 }],
    ["the typeface file", { fileSha256: GEIST_SHA256.replace(/^./, first => first === "0" ? "1" : "0") }],
  ];
  const names = new Set([name]);
  for (const [what, change] of changed) {
    const other = textPictureName({ ...named, ...change });
    assert.ok(!names.has(other), `${what} changes the name`);
    names.add(other);
  }

  // The painter's version is in the name: the name is this hash, and another version's is not.
  const hashed = (painter: string) => sha256(Buffer.from(canonicalJson({ painter, file: GEIST_SHA256, width: ask.width, height: ask.height, text: ask.text, look: ask.look })));
  assert.equal(hashed(TEXT_PAINTER_VERSION), name);
  assert.notEqual(hashed("text-painter-v1"), name);
  assert.notEqual(hashed("text-painter-v3"), name);

  // One accented letter typed two ways is one picture under one name.
  const joined = { ...ask, text: "Café" }, apart = { ...ask, text: "Café" };
  assert.notEqual(joined.text, apart.text);
  const first = paint(joined), second = paint(apart);
  assert.equal(first.name, second.name);
  assert.ok(same(first.rgba, second.rgba));
});

it("draws a line too wide for its room smaller and leaves the stored look alone (R-10)", () => {
  const { ink, picture } = paintProofName("The Lady in White");
  assert.equal(ink.size, 0.0708);
  assert.ok(picture.drawnSize < ink.size && picture.drawnSize > ink.size / 2, `drawn at ${picture.drawnSize}`);
  assert.equal(paintProofName("Ade").picture.drawnSize, 0.0708);

  const ask = card("fit"), before = structuredClone(ask.look), picture2 = paint(ask);
  assert.ok(picture2.drawnSize < ask.look.size / 2, `drawn at ${picture2.drawnSize}`);
  assert.deepEqual(ask.look, before);
  // The name is of the look as stored: what Fit made of it is not a second picture.
  assert.equal(picture2.name, textPictureName({ ...ask, fileSha256: GEIST_SHA256 }));
});

it("refuses by name and hands back no picture (R-7, R-21)", async () => {
  const ask = card("block"), geist = readFileSync(join(fonts, GEIST_FILE));
  // U+1E63, the dotted s of a Yoruba name: Geist does not have it, and no other face is tried.
  assert.deepEqual(paintTextPicture({ ...ask, text: "Oṣun" }), { ok: false, reason: "Geist has no ṣ" });
  assert.deepEqual(paintTextPicture({ ...ask, text: "Oṣun" }), { ok: false, reason: "Geist has no ṣ" });
  assert.deepEqual(paintTextPicture({ ...ask, look: { ...ask.look, italic: true } }), { ok: false, reason: "Geist has no italic" });
  assert.deepEqual(paintTextPicture({ ...ask, look: { ...ask.look, typeface: "bangers", weight: "bold" } }), { ok: false, reason: "Bangers has no bold" });
  assert.deepEqual(paintTextPicture({ ...ask, look: { ...ask.look, typeface: "cinzel", italic: true } }), { ok: false, reason: "Cinzel has no italic" });
  // A mark the face holds and has nowhere to put on this letter: the shaper fails, and that is a refusal too.
  assert.deepEqual(paintTextPicture({ ...ask, text: "a\u0327", look: { ...ask.look, typeface: "cinzel" } }), { ok: false, reason: "Cinzel cannot draw a\u0327" });
  assert.deepEqual(paintTextPicture({ ...ask, width: 8 }), { ok: false, reason: "A text picture is 16 to 8192 whole pixels each way" });

  // A bundle whose Geist is one byte off, and a bundle with no fonts beside it.
  const altered = Uint8Array.from(geist);
  altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
  assert.deepEqual(paintTextPicture(ask, await bundle(altered)), { ok: false, reason: `${GEIST_FILE} is not the file this app shipped with` });
  assert.deepEqual(paintTextPicture(ask, await bundle()), { ok: false, reason: `${GEIST_FILE} is missing` });
  // The file that was shipped, read from beside a bundle, paints what the source folder's does.
  const packaged = paint(ask, await bundle(geist)), source = paint(ask);
  assert.equal(packaged.name, source.name);
  assert.ok(same(packaged.rgba, source.rgba));
});

it("refuses at the door what a clip's record refuses, and paints the words as they are stored (R-3, R-4, R-26)", () => {
  const ask = card("block"), tried = (change: object) => paintTextPicture({ ...ask, ...change } as Parameters<typeof paintTextPicture>[0]);
  // No words is never a blank picture with a name.
  for (const text of ["", "\n\n", "   ", " \r\n\t"]) assert.deepEqual(tried({ text }), { ok: false, reason: "Type some words" }, JSON.stringify(text));
  assert.deepEqual(tried({ text: Array.from({ length: 13 }, () => "a").join("\n") }), { ok: false, reason: "Text holds at most 12 lines" });
  assert.deepEqual(tried({ text: "a".repeat(501) }), { ok: false, reason: "Text holds at most 500 characters" });
  assert.ok(tried({ text: `${"a ".repeat(249)}aa` }).ok, "500 characters paint");

  // A look the record would refuse is refused by the field that is wrong, and nothing is clamped to fit.
  const look = (change: object) => tried({ look: { ...ask.look, ...change } });
  const refusals: [object, string][] = [
    [{ size: 5 }, "A text look's size is out of range"],
    [{ size: 0 }, "A text look's size is out of range"],
    [{ size: -0.1 }, "A text look's size is out of range"],
    [{ size: null }, "A text look's size is out of range"],
    [{ room: 0 }, "A text look's room is out of range"],
    [{ tracking: -1 }, "A text look's tracking is out of range"],
    [{ x: 7 }, "A text look's x is out of range"],
    [{ align: "justify" }, "A text look's align is out of range"],
    [{ fill: { kind: "solid", color: "red" } }, "A text look's fill.color is out of range"],
    [{ fill: { kind: "gradient", stops: [] } }, "A text look's fill.stops is out of range"],
    [{ fill: { kind: "gradient", stops: [{ at: 0, color: "#ffffff" }] } }, "A text look's fill.stops is out of range"],
    [{ fill: { kind: "gradient", stops: [{ at: 0, color: "#ffffff" }, { at: 2, color: "#000000" }] } }, "A text look's fill.stops.1.at is out of range"],
    [{ shadow: { color: "#000000", opacity: 1, blur: 50, dx: 0, dy: 0 } }, "A text look's shadow.blur is out of range"],
    [{ stray: 1 }, "A text look has no stray"],
    [{ fill: { kind: "solid", color: "#ffffff", angle: 90 } }, "A text look has no fill.angle"],
    [{ typeface: "comic" }, "A text look's typeface is out of range"],
  ];
  for (const [change, reason] of refusals) assert.deepEqual(look(change), { ok: false, reason }, JSON.stringify(change));
  assert.deepEqual(tried({ look: undefined }), { ok: false, reason: "A text look cannot be read" });

  // Typed with blank lines around it or a Windows line end, a clip is the words it stores: one picture, one name.
  const stored = paint({ ...ask, text: "Ade\nTunde" });
  for (const typed of ["\n\nAde\nTunde", "Ade\r\nTunde", "Ade\rTunde\r\n", "  \nAde\nTunde\n\n"]) {
    const picture = paint({ ...ask, text: typed });
    assert.equal(picture.name, stored.name, JSON.stringify(typed));
    assert.ok(same(picture.rgba, stored.rgba), JSON.stringify(typed));
  }

  // A colour is the same colour in either case, so it is the same picture under the same name.
  const upper = { ...ask.look, fill: { kind: "solid" as const, color: "#FFFFFF" }, backing: { kind: "box" as const, color: "#1014AB", opacity: 0.82 } };
  const lower = { ...upper, fill: { kind: "solid" as const, color: "#ffffff" }, backing: { ...upper.backing, color: "#1014ab" } };
  const one = paint({ ...ask, look: upper }), other = paint({ ...ask, look: lower });
  assert.ok(same(one.rgba, other.rgba));
  assert.equal(one.name, other.name);
  assert.equal(textPictureName({ ...ask, look: upper, fileSha256: GEIST_SHA256 }), one.name);
  const stops = (first: string, second: string): TextLook => ({ ...ask.look, fill: { kind: "gradient", stops: [{ at: 0, color: first }, { at: 1, color: second }] }, edge: { color: first, width: 0.05 }, shadow: { color: second, opacity: 1, blur: 0, dx: 0, dy: 0.1 } });
  assert.equal(paint({ ...ask, look: stops("#AbCdEf", "#00FF7f") }).name, paint({ ...ask, look: stops("#abcdef", "#00ff7F") }).name);
  assert.notEqual(paint({ ...ask, look: stops("#abcdef", "#00ff7f") }).name, paint({ ...ask, look: stops("#abcdee", "#00ff7f") }).name);
});
