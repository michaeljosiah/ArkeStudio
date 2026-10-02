import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { cadenceSupport, sentAs, supportedDeliveries, SOUNDS, type CadencePlan } from "@arke-studio/contracts";
import { requireModel, SHIPPED_MANIFEST } from "../src/index.js";

// Design turn 181: one direction, every reader in its own syntax — the shipped rows, not stand-ins.
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const line = "Don’t you dare walk away from me, Ade. Not this time.";
const after = (words: string) => line.indexOf(words) + words.length;
const plan: CadencePlan = {
  schemaVersion: 1, sourceTextHash: hash(line), delivery: "cold", speed: 1,
  note: "angry and hurt — quieter, not louder; holding back tears",
  cues: [
    { kind: "pause", at: after("Ade."), length: "long" },
    { kind: "emphasis", span: { from: line.indexOf("this"), to: line.indexOf("this") + 4, text: "this" }, level: "strong" },
    { kind: "sound", at: line.length, sound: "sighs" },
  ],
};
const row = (id: string) => {
  const found = requireModel(SHIPPED_MANIFEST, id);
  if (!found.ok) throw new Error(found.reason);
  return found.model;
};

it("renders one direction into each shipped reader's own syntax, holding what it cannot take", () => {
  const table = Object.fromEntries(
    ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "eleven-v3", "eleven_multilingual_v2", "breeze-tts-2", "fish-s2.1-pro", "voxtral-mini-tts", "kokoro-82m"].map((id) => {
      const sent = sentAs(line, plan, row(id), id === "breeze-tts-2" ? "en" : undefined);
      return [id, { text: sent.text, style: sent.style, held: sent.held.map((h) => h.control) }];
    }),
  );
  const gemini = { text: "Don’t you dare walk away from me, Ade. <long pause> Not THIS time. <sigh>",
    style: "Read coldly and flatly, without warmth. Angry and hurt — quieter, not louder; holding back tears.", held: [] };
  assert.deepEqual(table["gemini-3.8-flash-tts"], gemini);
  assert.deepEqual(table["gemini-3.8-flash-lite-tts"], gemini, "both Gemini rows read alike");
  assert.deepEqual(table["eleven-v3"], { text: "[coldly] [angry and hurt — quieter, not louder; holding back tears] Don’t you dare walk away from me, Ade. [long pause] Not THIS time. [sighs]", style: undefined, held: [] },
    "the note, 58 characters, is one tag");
  assert.deepEqual(table["eleven_multilingual_v2"], { text: "Don’t you dare walk away from me, Ade. <break time=\"1.5s\"/> Not THIS time.", style: undefined, held: ["delivery", "sound", "note"] });
  assert.deepEqual(table["breeze-tts-2"], { text: "Don’t you dare walk away from me, Ade. (pause) Not this time. (sigh)",
    style: "Say it coldly — flat, distant, without warmth. Angry and hurt — quieter, not louder; holding back tears.", held: ["emphasis"] });
  assert.deepEqual(table["fish-s2.1-pro"], { text: "[cold and flat, without warmth] [angry and hurt — quieter, not louder; holding back tears] Don’t you dare walk away from me, Ade. [long pause] Not this time. [sighing]", style: undefined, held: ["emphasis"] });
  assert.deepEqual(table["voxtral-mini-tts"], { text: "Don’t you dare walk away from me, Ade… Not this time.", style: undefined, held: ["delivery", "emphasis", "sound", "note"] });
  assert.deepEqual(table["kokoro-82m"], { text: "Don’t you dare walk away from me, Ade… Not this time.", style: undefined, held: ["delivery", "emphasis", "sound", "note"] });
});

it("a note over sixty characters is held by a tag reader, and Breeze holds its tags for a line not stated English", () => {
  const long = { ...plan, note: "angry and hurt — quieter, not louder; holding back tears, then slower" };
  const eleven = sentAs(line, long, row("eleven-v3"));
  assert.equal(eleven.text.startsWith("[coldly] Don’t"), true);
  assert.deepEqual(eleven.held, [{ control: "note", reason: "a tag takes 60 characters" }]);
  assert.equal(sentAs(line, long, row("gemini-3.8-flash-tts")).style?.endsWith("then slower."), true, "an instruction reader takes it whole");
  const french = sentAs(line, plan, row("breeze-tts-2"), "fr");
  assert.equal(french.text, "Don’t you dare walk away from me, Ade. Not this time.");
  assert.deepEqual(french.held.map((h) => h.control), ["pause", "emphasis", "sound"]);
});

it("support comes from the cadence row alone: Eleven v3 offers its six deliveries, Multilingual v2 none", () => {
  assert.deepEqual(supportedDeliveries(row("eleven-v3")), ["measured", "whispered", "breaking", "cold", "warm", "urgent"]);
  assert.deepEqual(supportedDeliveries(row("eleven_multilingual_v2")), []);
  for (const model of SHIPPED_MANIFEST.models.filter((m) => m.capability === "voice-tts")) {
    assert.equal(model.limits.deliveries, undefined, `${model.id} declares no retired limit`);
  }
  // Gemini makes every portable sound; Kokoro and Voxtral make none.
  for (const sound of SOUNDS) {
    assert.equal(cadenceSupport(row("gemini-3.8-flash-tts")).sounds[sound].status, "best-effort", sound);
    assert.equal(cadenceSupport(row("eleven-v3")).sounds[sound].status, "best-effort", sound);
    assert.equal(cadenceSupport(row("kokoro-82m")).sounds[sound].status, "unsupported", sound);
  }
});
