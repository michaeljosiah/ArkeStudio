import assert from "node:assert/strict";
import { it } from "node:test";
import { audiobookDirectionHash } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { checkDirection, compileLine, directionPlan } from "../../src/voice/direction.js";

// The one direction module (design turn 181, SPEC-049 R-28): a one-request surface's compile.
const row = (id: string) => SHIPPED_MANIFEST.models.find((model) => model.id === id)!;
const text = "I’m here. You came back.";

it("compiles a line for one request in the reader's syntax, named by its authored direction", () => {
  const input = { delivery: "cold" as const, speed: 1, note: "quietly", cues: [{ kind: "sound" as const, at: 9, sound: "laughs" as const }] };
  const compiled = compileLine(text, input, row("gemini-3.8-flash-tts"), undefined, "hold");
  assert.ok(compiled.ok);
  assert.equal(compiled.line.text, "I’m here. <laugh> You came back.");
  assert.equal(compiled.line.instructions, "Read coldly and flatly, without warmth. Quietly.");
  assert.deepEqual(compiled.line.held, []);
  assert.equal(compiled.line.directionHash, audiobookDirectionHash(directionPlan(text, input)));
});

it("holds a marker the reader could only make in parts, by name, and strict refuses it", () => {
  const input = { speed: 1, cues: [{ kind: "delivery" as const, span: { from: 0, to: 9, text: "I’m here." }, delivery: "whispered" as const }] };
  const held = compileLine(text, input, row("gemini-3.8-flash-tts"), undefined, "hold");
  assert.ok(held.ok);
  assert.deepEqual(held.line.held, [{ control: "marker", cueIndex: 0, reason: "needs a read in parts" }]);
  assert.equal(held.line.text, text);
  assert.equal(held.line.plan.cues.length, 1, "the authored plan is kept whole");
  const strict = compileLine(text, input, row("gemini-3.8-flash-tts"), undefined, "strict");
  assert.deepEqual(strict, { ok: false, kind: "held", reason: "[whispered] · Gemini 3.8 Flash TTS needs a read in parts" });
  // A tag reader writes a marker inline when nothing after it needs the reading restored — it
  // runs to the end, or the block's own delivery has a tag to write back after it (R-41).
  const toEnd = { speed: 1, cues: [{ kind: "delivery" as const, span: { from: 10, to: text.length, text: "You came back." }, delivery: "whispered" as const }] };
  const inline = compileLine(text, toEnd, row("eleven-v3"), undefined, "hold");
  assert.ok(inline.ok);
  assert.equal(inline.line.text, "I’m here. [whispers] You came back.");
  const restored = compileLine(text, { ...input, delivery: "warm" }, row("eleven-v3"), undefined, "hold");
  assert.ok(restored.ok);
  assert.equal(restored.line.text, "[warmly] [whispers] I’m here. [warmly] You came back.");
  const unrestorable = compileLine(text, input, row("eleven-v3"), undefined, "hold");
  assert.ok(unrestorable.ok);
  assert.deepEqual(unrestorable.line.held, [{ control: "marker", cueIndex: 0, reason: "needs a read in parts" }], "a whisper with no reading to return to would run on");
});

it("holds what Kokoro cannot take, and refuses words that will not fit one request", () => {
  const kokoro = compileLine(text, { delivery: "cold", speed: 1, cues: [{ kind: "sound", at: 9, sound: "sighs" }] }, row("kokoro-82m"), undefined, "hold");
  assert.ok(kokoro.ok);
  assert.deepEqual(kokoro.line.held.map((h) => h.control), ["delivery", "sound"]);
  assert.equal(kokoro.line.text, text);
  const long = compileLine("word ".repeat(1200), { speed: 1, cues: [] }, row("eleven-v3"), undefined, "hold");
  assert.ok(!long.ok && /request limit/.test(long.reason));
  assert.deepEqual(compileLine("  ", { speed: 1, cues: [] }, row("eleven-v3"), undefined, "hold"), { ok: false, kind: "empty", reason: "There are no words to read yet." });
});

it("an author's note longer than a tag is held on a tag reader, not refused; a reader with no note still refuses one (design turn 181)", () => {
  const long = "angry and hurt — quieter, not louder; holding back tears, slower";
  const v3 = checkDirection(text, directionPlan(text, { delivery: "cold", speed: 1, cues: [], note: long }), row("eleven-v3"), undefined, "strict");
  assert.ok(v3.ok, v3.ok ? undefined : v3.reason);
  assert.deepEqual(v3.held, [{ control: "note", reason: "a tag takes 60 characters" }]);
  assert.equal(v3.parts[0]?.text, "[coldly] I’m here. You came back.");
  const kokoro = checkDirection(text, directionPlan(text, { delivery: "measured", speed: 1, cues: [], note: "flat" }), row("kokoro-82m"), undefined, "strict");
  assert.deepEqual(kokoro, { ok: false, reason: "note · Kokoro 82M no note" });
});
