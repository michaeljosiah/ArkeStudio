import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canonicalJson } from "../src/canonical-json.js";
import type { TextLook } from "../src/editor-text.js";
import { PRESETS } from "../src/cut.js";
import { TEXT_FRAME_MAX, TEXT_FRAME_MIN, layoutText } from "../src/editor-text-layout.js";
import { TEXT_PICTURE_DIR, TEXT_PICTURE_PATH, textPictureFrame, textPictureName, textPicturePath } from "../src/editor-text-pictures.js";
import { TEXT_PAINTER_VERSION, TEXT_TYPEFACES } from "../src/editor-text-typefaces.js";
import { proofFace, proofInk } from "./editor-text-fixture.js";

// The name a text clip's painted picture is kept under (SPEC-065 R-20, §2.3). The coordinator
// made it with node:crypto until the render plan needed it in a browser; these tests are what
// says the name did not change when it moved, and that the plan and the painter cannot disagree.

const GEIST_SHA256 = TEXT_TYPEFACES.geist.files.regular.sha256;
const plain = (): TextLook => ({
  typeface: "geist", weight: "regular", italic: false, size: 0.08, tracking: 0, leading: 1.2, capitals: false, align: "center", x: 0.5, y: 0.5, room: 0.8,
  fill: { kind: "solid", color: "#ffffff" },
});
/** Every optional part of a look, each with a colour of its own. */
const rich = (): TextLook => ({
  typeface: "geist", weight: "regular", italic: false, size: 0.07, tracking: 0.02, leading: 1.1, capitals: false, align: "center", x: 0.5, y: 0.8, room: 0.9,
  fill: { kind: "gradient", stops: [{ at: 0, color: "#fff4c8" }, { at: 1, color: "#b98a2e" }] },
  edge: { color: "#1a1208", width: 0.02 },
  shadow: { color: "#000000", opacity: 0.8, blur: 0.25, dx: 0, dy: 0.03 },
  rule: { length: 0.2, weight: 0.02, gap: 0.3, soft: true },
  backing: { kind: "shade", color: "#00000a", opacity: 0.5 },
});
/** The digest as the coordinator took it before the name moved: node:crypto over the canonical JSON, built here by hand. */
const hashed = (value: { painter: string; file: string; width: number; height: number; text: string; look: TextLook }) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

test("a picture's name is the digest node:crypto gives the same canonical JSON (§2.3)", () => {
  const texts = ["Ife Adebayo", "Line one\nLine two", "Ọ̀rẹ́ mi", "語 😀", "a".repeat(500), 'q"\\\n'];
  for (const look of [plain(), rich()]) for (const text of texts) for (const [width, height] of [[1080, 1920], [1920, 1080], [1280, 720], [1, 1]] as const) {
    const name = textPictureName({ text, look, width, height, fileSha256: GEIST_SHA256 });
    assert.match(name, /^[0-9a-f]{64}$/);
    assert.equal(name, hashed({ painter: TEXT_PAINTER_VERSION, file: GEIST_SHA256, width, height, text: text.normalize("NFC"), look }));
  }

  // The names the coordinator's own function gave these two asks at the commit before it moved
  // here (main at fedb18b42, text-painter-v2), computed there and written down: a kept picture
  // from that build is still found.
  assert.equal(textPictureName({ text: "Ife Adebayo", look: plain(), width: 1080, height: 1920, fileSha256: GEIST_SHA256 }),
    "acea14b52f840481ee7a73ed95a1e074935e99968135af061a60e7cace9cd033");
  assert.equal(textPictureName({ text: "Ọ̀rẹ́ mi\nLagos", look: { ...rich(), fill: { kind: "gradient", stops: [{ at: 0, color: "#FFF4C8" }, { at: 1, color: "#b98a2e" }] }, edge: { color: "#1A1208", width: 0.02 } }, width: 1920, height: 1080, fileSha256: GEIST_SHA256 }),
    "7aadfbf04740f246cc2a99e00707f1e7b701a8e995ad8e5562ada9c11835ab32");

  // The painter's version and the typeface file are in the name, and nothing outside the ask is.
  const ask = { text: "Ife Adebayo", look: rich(), width: 1080, height: 1920, fileSha256: GEIST_SHA256 }, name = textPictureName(ask);
  assert.notEqual(hashed({ painter: "text-painter-v0", file: GEIST_SHA256, width: 1080, height: 1920, text: ask.text, look: ask.look }), name);
  assert.equal(textPictureName(structuredClone(ask)), name);
  // The same look typed in another order is the same picture.
  const { typeface, fill, ...rest } = ask.look, reordered: TextLook = { ...rest, fill, typeface };
  assert.notDeepEqual(Object.keys(reordered), Object.keys(ask.look));
  assert.equal(textPictureName({ ...ask, look: reordered }), name);
  // Naming a picture changes nothing it was handed.
  assert.deepEqual(ask.look, rich());
});

test("a changed word, look or frame size is a different picture; a colour's case and a composed accent are not (§3.2)", () => {
  const ask = { text: "Ife Adebayo\nLagos", look: rich(), width: 1080, height: 1920, fileSha256: GEIST_SHA256 }, name = textPictureName(ask);
  const changed: Array<[string, Partial<typeof ask>]> = [
    ["a word", { text: ask.text.replace("Lagos", "Ibadan") }],
    ["a letter's case", { text: ask.text.toLowerCase() }],
    ["a line break", { text: ask.text.replace("\n", " ") }],
    ["a space at the end", { text: `${ask.text} ` }],
    ["the size", { look: { ...ask.look, size: ask.look.size + 0.001 } }],
    ["the tracking", { look: { ...ask.look, tracking: 0.03 } }],
    ["the alignment", { look: { ...ask.look, align: "left" } }],
    ["where it sits", { look: { ...ask.look, y: 0.81 } }],
    ["the fill", { look: { ...ask.look, fill: { kind: "solid", color: "#fffffe" } } }],
    ["a gradient stop", { look: { ...ask.look, fill: { kind: "gradient", stops: [{ at: 0, color: "#fff4c8" }, { at: 0.9, color: "#b98a2e" }] } } }],
    ["the edge's colour", { look: { ...ask.look, edge: { ...ask.look.edge!, color: "#1a1209" } } }],
    ["the shadow's blur", { look: { ...ask.look, shadow: { ...ask.look.shadow!, blur: 0.26 } } }],
    ["the rule", { look: { ...ask.look, rule: { ...ask.look.rule!, soft: false } } }],
    ["the backing's opacity", { look: { ...ask.look, backing: { ...ask.look.backing!, opacity: 0.51 } } }],
    ["no backing", { look: (({ backing: _backing, ...rest }) => rest)(ask.look) }],
    ["capitals", { look: { ...ask.look, capitals: true } }],
    ["the width", { width: ask.width + 1 }],
    ["the height", { height: ask.height - 1 }],
    ["the frame turned on its side", { width: ask.height, height: ask.width }],
    ["the typeface file", { fileSha256: GEIST_SHA256.replace(/^./, first => first === "0" ? "1" : "0") }],
  ];
  const names = new Set([name]);
  for (const [what, change] of changed) {
    const other = textPictureName({ ...ask, ...change });
    assert.ok(!names.has(other), `${what} changes the name`);
    names.add(other);
  }

  // One colour written in either case is one picture, wherever in the look it sits.
  const upper: TextLook = {
    ...ask.look, fill: { kind: "gradient", stops: [{ at: 0, color: "#FFF4C8" }, { at: 1, color: "#B98A2E" }] },
    edge: { ...ask.look.edge!, color: "#1A1208" }, shadow: { ...ask.look.shadow!, color: "#000000" }, backing: { ...ask.look.backing!, color: "#00000A" },
  };
  assert.equal(textPictureName({ ...ask, look: upper }), name);
  assert.equal(textPictureName({ ...ask, look: { ...plain(), fill: { kind: "solid", color: "#ABCDEF" } } }), textPictureName({ ...ask, look: { ...plain(), fill: { kind: "solid", color: "#abcdef" } } }));
  assert.deepEqual(upper.fill, { kind: "gradient", stops: [{ at: 0, color: "#FFF4C8" }, { at: 1, color: "#B98A2E" }] }, "the look handed in keeps its own spelling");

  // An accented letter typed as one character or as a letter and a mark is one picture: the painter reads both in NFC.
  assert.notEqual("é", "é");
  assert.equal(textPictureName({ ...ask, text: "Café" }), textPictureName({ ...ask, text: "Café" }));
  // Half a surrogate pair is not U+FFFD to the name, though it is to the digest: JSON writes it as an escape.
  assert.notEqual(textPictureName({ ...ask, text: "\ud800" }), textPictureName({ ...ask, text: "�" }));
  assert.equal(textPictureName({ ...ask, text: "\ud800" }), hashed({ painter: TEXT_PAINTER_VERSION, file: GEIST_SHA256, width: ask.width, height: ask.height, text: "\ud800", look: ask.look }));
});

test("a text source names .cache/editor-text/<64 hex>.png, and a weight the face lacks refuses by name (R-7, R-20)", () => {
  assert.equal(TEXT_PICTURE_DIR, ".cache/editor-text");
  // A clip's source carries more than the words and the look; the name reads only those two.
  const source = { kind: "text" as const, label: "Ife Adebayo", text: "Ife Adebayo", look: plain() };
  const kept = textPicturePath(source, { width: 1080, height: 1920 });
  assert.ok(kept.ok);
  assert.equal(kept.name, textPictureName({ text: source.text, look: source.look, width: 1080, height: 1920, fileSha256: GEIST_SHA256 }));
  assert.deepEqual(kept, { ok: true, name: kept.name, path: `.cache/editor-text/${kept.name}.png`, width: 1080, height: 1920 });
  assert.equal(TEXT_PICTURE_PATH.exec(kept.path)?.[1], kept.name);
  assert.deepEqual(textPicturePath({ text: source.text, look: plain() }, { width: 1080, height: 1920 }), kept);

  // One picture per frame size (§2.3): the Viewer's and an export's at another size are two files.
  const wide = textPicturePath(source, { width: 1920, height: 1080 });
  assert.ok(wide.ok);
  assert.notEqual(wide.name, kept.name);
  assert.deepEqual([wide.width, wide.height], [1920, 1080]);

  // Geist ships in regular alone. A weight or slant it lacks refuses in the typeface's words, and no name is made (R-7).
  assert.deepEqual(textPicturePath({ ...source, look: { ...plain(), typeface: "bangers", weight: "bold" } }, { width: 1080, height: 1920 }), { ok: false, reason: "Bangers has no bold" });
  assert.deepEqual(textPicturePath({ ...source, look: { ...plain(), italic: true } }, { width: 1080, height: 1920 }), { ok: false, reason: "Geist has no italic" });
  assert.deepEqual(textPicturePath({ ...source, look: { ...plain(), weight: "bold", italic: true } }, { width: 1080, height: 1920 }), { ok: false, reason: "Geist has no italic" });

  // The pattern is a kept picture's whole path and nothing near it: it is what lets the media
  // route serve this folder and the sweep delete from it.
  const hex = "0123456789abcdef".repeat(4);
  assert.ok(TEXT_PICTURE_PATH.test(`.cache/editor-text/${hex}.png`));
  assert.ok(TEXT_PICTURE_PATH.test(`.cache/editor-text/${hex}.png`), "asking twice gives the same answer: the pattern keeps no place");
  for (const path of [
    `.cache/editor-text/${hex.slice(1)}.png`, `.cache/editor-text/${hex}0.png`, `.cache/editor-text/${hex.toUpperCase()}.png`, `.cache/editor-text/${hex.replace("0", "g")}.png`,
    `.cache/editor-text/${hex}.PNG`, `.cache/editor-text/${hex}.jpg`, `.cache/editor-text/${hex}.png.tmp`, `.cache/editor-text/${hex}`, `.cache/editor-text/${hex}.png/`,
    `.cache/editor-text/sub/${hex}.png`, `.cache/editor-text/../editor-text/${hex}.png`, `.cache\\editor-text\\${hex}.png`, `/.cache/editor-text/${hex}.png`,
    `./.cache/editor-text/${hex}.png`, `x/.cache/editor-text/${hex}.png`, `.cache/editor-texts/${hex}.png`, `.cache/editor-effects/${hex}.png`, `.cache/editor-text/${hex}.png\n`, `${hex}.png`, "",
  ]) assert.ok(!TEXT_PICTURE_PATH.test(path), JSON.stringify(path));
});

test("a moving clip's picture is painted at twice its frame, inside the painter's ceiling at every preset (R-17)", () => {
  const frame = { width: 1280, height: 720 };
  assert.equal(textPictureFrame(frame, false), frame);
  assert.deepEqual(textPictureFrame(frame, true), { width: 2560, height: 1440 });
  // A doubled preset past the ceiling would refuse by name at export rather than paint a smaller
  // picture, so every one there is is held inside it here.
  for (const [preset, { width, height }] of Object.entries(PRESETS)) {
    const doubled = textPictureFrame({ width, height }, true);
    for (const side of [doubled.width, doubled.height]) assert.ok(side >= TEXT_FRAME_MIN && side <= TEXT_FRAME_MAX, `${preset} doubled is ${doubled.width}x${doubled.height}`);
    assert.ok(layoutText("av", proofInk(), doubled, proofFace().face).ok, `${preset} doubled lays out`);
  }
  assert.ok(layoutText("av", proofInk(), { width: 2 * 1920, height: 2 * 1920 }, proofFace().face).ok, "the largest side doubled");
  // The doubled picture is another file beside the still one, never the same name.
  const source = { text: "Ife Adebayo", look: plain() };
  const still = textPicturePath(source, frame), moving = textPicturePath(source, textPictureFrame(frame, true));
  assert.ok(still.ok && moving.ok);
  assert.notEqual(moving.name, still.name);
  assert.deepEqual([moving.width, moving.height], [2560, 1440]);
});
