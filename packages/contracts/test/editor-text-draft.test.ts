import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ClientMessageSchema, FrameSchema, PRESETS, TEXT_DRAFT_PNG_MAX, TEXT_SET_MAX_CLIPS, TEXT_TYPEFACE_DATA_MAX, TEXT_TYPEFACE_IDS, TextDraftCommandSchema,
  invalidCommandRefusal, isRemoteHostCommand, type TextLook,
} from "../src/index.js";

/**
 * A title drawn while it is typed (SPEC-065 R-32): the ask a window sends and the answer only it
 * receives. Every bound is the wire's, so a breach is the transport's `invalid`, answered with its
 * request id, and the coordinator never reads a word of it.
 */

const REQUEST = "12345678-1234-4234-8234-123456789abc";
const LOOK: TextLook = { typeface: "geist", weight: "regular", italic: false, size: 0.08, tracking: 0, leading: 1.2, capitals: false,
  align: "center", x: 0.5, y: 0.5, room: 0.9, fill: { kind: "solid", color: "#ffffff" } };
const item = (text = "Ade", look: object = LOOK) => ({ text, look });
const paint = (change: object = {}) => ({ kind: "text-draft", requestId: REQUEST, frame: { width: 1280, height: 720 }, ask: { kind: "paint", item: item() }, ...change });
const measure = (count: number) => paint({ ask: { kind: "measure", items: Array.from({ length: count }, (_, index) => item(`Name ${index}`)) } });
const reads = (value: unknown) => ClientMessageSchema.safeParse(value).success;
const frame = (answer: unknown) => FrameSchema.safeParse({ kind: "text-draft", seq: 4, requestId: REQUEST, answer }).success;
const NAME = "a".repeat(64);

test("a draft ask holds 1 to 50 items; 51 refuse", () => {
  assert.equal(TEXT_SET_MAX_CLIPS, 50);
  assert.equal(reads(measure(1)), true);
  assert.equal(reads(measure(50)), true);
  assert.equal(reads(measure(51)), false);
  assert.equal(reads(measure(0)), false);
  // Refused as invalid, by its kind and request id, so the window that asked stops waiting (issue 2778).
  assert.deepEqual(invalidCommandRefusal(measure(51)), { kind: "command-refused", refused: "invalid", command: "text-draft", requestId: REQUEST });
});

test("a picture is asked of one item only", () => {
  assert.equal(reads(paint()), true);
  assert.equal(reads(paint({ ask: { kind: "paint", items: [item(), item("Ife")] } })), false, "a paint names one item, not a list");
  assert.equal(reads(paint({ ask: { kind: "paint", item: item(), items: [item("Ife")] } })), false);
  assert.equal(reads(paint({ ask: { kind: "measure", item: item() } })), false, "a measure is a list");
  assert.equal(reads(paint({ ask: { kind: "both", item: item() } })), false);
  assert.equal(reads(paint({ picture: true })), false, "nothing rides beside the ask");
});

test("a draft is drawn at a preset's size; a doubled or odd frame refuses", () => {
  const sizes = new Set(Object.values(PRESETS).map(({ width, height }) => `${width}x${height}`));
  assert.deepEqual([...sizes].sort(), ["1080x1920", "1280x720", "1920x1080"]);
  for (const size of sizes) {
    const [width, height] = size.split("x").map(Number);
    assert.equal(reads(paint({ frame: { width, height } })), true, size);
  }
  for (const [width, height] of [[2560, 1440], [3840, 2160], [2160, 3840], [1281, 720], [720, 1280], [1280.5, 720], [16, 16], [0, 0]]) {
    assert.equal(reads(paint({ frame: { width, height } })), false, `${width}x${height}`);
  }
  assert.equal(reads(paint({ frame: { width: 1280, height: 720, scale: 2 } })), false);
});

test("a draft's words and look are the record's: 501 characters, 13 lines and an unknown field refuse", () => {
  assert.equal(reads(paint({ ask: { kind: "paint", item: item("a".repeat(500)) } })), true);
  assert.equal(reads(paint({ ask: { kind: "paint", item: item("a".repeat(501)) } })), false);
  assert.equal(reads(paint({ ask: { kind: "paint", item: item(Array.from({ length: 12 }, () => "a").join("\n")) } })), true);
  assert.equal(reads(paint({ ask: { kind: "paint", item: item(Array.from({ length: 13 }, () => "a").join("\n")) } })), false);
  assert.equal(reads(paint({ ask: { kind: "paint", item: item(" \n ") } })), false, "words with nothing to draw");
  assert.equal(reads(paint({ ask: { kind: "paint", item: item("Ade", { ...LOOK, size: 0.5 }) } })), false, "a value out of range");
  assert.equal(reads(paint({ ask: { kind: "paint", item: item("Ade", { ...LOOK, stray: 1 }) } })), false, "a field the look has not");
  assert.equal(reads(paint({ ask: { kind: "paint", item: item("Ade", { ...LOOK, typeface: "arial" }) } })), false, "a face the app has not");
  assert.equal(reads(paint({ ask: { kind: "paint", item: { ...item(), label: "Ade" } } })), false, "a field the item has not");
  assert.equal(reads(paint({ requestId: "not-a-uuid" })), false);
  // A face the look names but whose weight it lacks is the painter's to refuse by name, not the wire's.
  assert.equal(reads(paint({ ask: { kind: "paint", item: item("Ade", { ...LOOK, typeface: "bangers", weight: "bold" }) } })), true);
  const parsed = TextDraftCommandSchema.parse(paint({ ask: { kind: "paint", item: item("\n\nAde\r\n") } }));
  assert.ok(parsed.ask.kind === "paint");
  assert.equal(parsed.ask.item.text, "\n\nAde\r\n", "the words travel as typed; the painter stores them as a write would");
});

test("text-draft and text-typefaces are studio commands a paired device may send", () => {
  const typefaces = { kind: "text-typefaces", requestId: REQUEST };
  for (const message of [paint(), measure(3), typefaces]) {
    const parsed = ClientMessageSchema.parse(message);
    assert.equal(isRemoteHostCommand(parsed), false, parsed.kind);
  }
  assert.equal(reads({ ...typefaces, ids: ["geist"] }), false);
});

test("an answer's PNG is bounded", () => {
  const png = (length: number) => `${"A".repeat(length - 2)}==`;
  const drawn = (picture?: object, results: object[] = [{ ok: true, drawnSize: 0.08 }]) => ({ kind: "drawn", results, ...(picture ? { picture } : {}) });
  assert.equal(frame({ kind: "superseded" }), true);
  assert.equal(frame(drawn()), true, "a measure, or a paint that drew no picture");
  assert.equal(frame(drawn({ name: NAME, png: png(TEXT_DRAFT_PNG_MAX) })), true);
  assert.equal(frame(drawn({ name: NAME, png: png(TEXT_DRAFT_PNG_MAX + 4) })), false);
  assert.equal(frame(drawn({ name: NAME, png: "not base64!" })), false);
  assert.equal(frame(drawn({ name: NAME.slice(1), png: png(8) })), false, "a name is a kept picture's: 64 hex");
  // A picture answers one clip that drew.
  assert.equal(frame(drawn({ name: NAME, png: png(8) }, [{ ok: true, drawnSize: 0.08 }, { ok: true, drawnSize: 0.08 }])), false);
  assert.equal(frame(drawn({ name: NAME, png: png(8) }, [{ ok: false, reason: "Geist has no ẹ", field: "words" }])), false);
  // Results: one to fifty, each a size Fit drew or a refusal with its field.
  assert.equal(frame(drawn(undefined, [])), false);
  assert.equal(frame(drawn(undefined, Array.from({ length: 51 }, () => ({ ok: true, drawnSize: 0.08 })))), false);
  assert.equal(frame(drawn(undefined, [{ ok: false, reason: "Geist has no italic", field: "typeface" }, { ok: false, reason: "A text look's size is out of range", field: "look" }])), true);
  assert.equal(frame(drawn(undefined, [{ ok: false, reason: "Geist has no ẹ", field: "colour" }])), false);
  assert.equal(frame(drawn(undefined, [{ ok: true, drawnSize: 0.5 }])), false, "never larger than a size a look holds");
  assert.equal(frame({ kind: "drawn", results: [{ ok: true, drawnSize: 0.08 }], stray: 1 }), false);
});

test("the typefaces answer carries each face once, within its bound", () => {
  const faces = (value: unknown) => FrameSchema.safeParse({ kind: "text-typefaces", seq: 2, requestId: REQUEST, faces: value }).success;
  assert.equal(faces([]), true, "none readable is still an answer");
  assert.equal(faces(TEXT_TYPEFACE_IDS.map(id => ({ id, data: "AAAA" }))), true);
  assert.equal(faces([{ id: "geist", data: "AAAA" }, { id: "geist", data: "AAAA" }]), false);
  assert.equal(faces([{ id: "arial", data: "AAAA" }]), false);
  assert.equal(faces([{ id: "geist", data: "A".repeat(TEXT_TYPEFACE_DATA_MAX + 4) }]), false);
  assert.equal(faces([{ id: "geist", data: "" }]), false);
});
