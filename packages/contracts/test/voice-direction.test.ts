import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import {
  cadenceSupport,
  directionWord,
  mapCadence,
  orderCues,
  recogniseDirection,
  sentAs,
  bracketNote,
  type CadencePlan,
  type ManifestModel,
} from "../src/index.js";

// One voice direction for every speech surface (design turn 181, SPEC-049 R-21/R-22/R-28).
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
type Row = Pick<ManifestModel, "id" | "provider" | "cadence">;
const plan = (text: string, extra: Partial<CadencePlan> = {}): CadencePlan => ({ schemaVersion: 1, sourceTextHash: hash(text), speed: 1, cues: [], ...extra });

// Rows shaped as the catalogue's are (providers/manifest-data.ts holds the real ones, and its
// tests render the same line through each of them).
const gemini: Row = { id: "gemini-3.8-flash-tts", provider: "google", cadence: {
  deliveries: ["measured", "cold"], speed: null, pause: "best-effort-audio-tag", emphasis: "best-effort-capitalization", breath: "best-effort-audio-tag",
  outputTimestamps: "none", phrase: "best-effort-instruction", tagSyntax: "angle", sounds: { sighs: "sigh", laughs: "laugh" },
  deliveryMappings: { measured: { settings: {}, instruction: "Read calmly." }, cold: { settings: {}, instruction: "Read coldly." } } } };
const elevenV2: Row = { id: "eleven_multilingual_v2", provider: "elevenlabs", cadence: {
  deliveries: [], speed: { min: 0.7, max: 1.2 }, pause: "best-effort-break", emphasis: "best-effort-capitalization", breath: "unsupported",
  outputTimestamps: "none", deliveryMappings: {} } };
const kokoro: Row = { id: "kokoro-82m", provider: "kokoro", cadence: {
  deliveries: ["measured", "urgent"], speed: null, pause: "best-effort-punctuation", emphasis: "unsupported", breath: "unsupported", outputTimestamps: "none",
  deliveryMappings: { measured: { settings: { speed: 0.92 } }, urgent: { settings: { speed: 1.15 } } } } };

const line = "Don’t you dare walk away from me, Ade. Not this time.";
const at = (words: string) => line.indexOf(words) + words.length;
const directed = plan(line, {
  delivery: "cold",
  note: "angry and hurt — quieter, not louder; holding back tears",
  cues: [
    { kind: "pause", at: at("Ade."), length: "long" },
    { kind: "emphasis", span: { from: line.indexOf("this"), to: line.indexOf("this") + 4, text: "this" }, level: "strong" },
    { kind: "sound", at: line.length, sound: "sighs" },
  ],
});

describe("each reader is sent its own syntax", () => {
  it("Gemini: delivery and note in the style, angle-bracket vocalizations, capitals, the words otherwise verbatim (181a)", () => {
    const mapped = mapCadence(line, hash(line), directed, gemini);
    assert.equal(mapped.providerText, "Don’t you dare walk away from me, Ade. <long pause> Not THIS time. <sigh>");
    assert.equal(mapped.instructions, "Read coldly. Angry and hurt — quieter, not louder; holding back tears.");
    assert.deepEqual(mapped.voiceSettings, {});
    assert.equal(mapped.providerText.includes("["), false, "nothing in square brackets reaches Gemini");
  });

  it("Eleven Multilingual v2: pauses as SSML breaks and capitals; delivery, note and sounds held", () => {
    const sent = sentAs(line, directed, elevenV2);
    assert.equal(sent.text, "Don’t you dare walk away from me, Ade. <break time=\"1.5s\"/> Not THIS time.");
    assert.equal(sent.style, undefined);
    assert.deepEqual(sent.held.map((h) => h.control), ["delivery", "sound", "note"]);
    const short = mapCadence(line, hash(line), plan(line, { cues: [{ kind: "pause", at: at("Ade."), length: "short" }] }), elevenV2);
    assert.match(short.providerText, /Ade\. <break time="0\.5s"\/> Not/);
  });

  it("Kokoro: a pause as punctuation, the rest held and named, never spoken (181d)", () => {
    const sent = sentAs(line, directed, kokoro);
    assert.equal(sent.text, "Don’t you dare walk away from me, Ade… Not this time.");
    assert.deepEqual(sent.held.map((h) => [h.control, h.reason]), [
      ["delivery", "reads measured · urgent"], ["emphasis", "no emphasis"], ["sound", "no sounds"], ["note", "no note"],
    ]);
    const comma = mapCadence("Wait here", hash("Wait here"), plan("Wait here", { cues: [{ kind: "pause", at: 4, length: "short" }] }), kokoro);
    assert.equal(comma.providerText, "Wait, here", "a short pause where the words have no stop is a comma");
    const stop = mapCadence("Wait. Here", hash("Wait. Here"), plan("Wait. Here", { cues: [{ kind: "pause", at: 5, length: "short" }] }), kokoro);
    assert.equal(stop.providerText, "Wait. Here", "a stop that is there already is the pause");
  });

  it("no delivery is the reader's own reading: nothing sent for it and nothing held", () => {
    const sent = sentAs("Wait here.", plan("Wait here."), gemini);
    assert.deepEqual(sent, { text: "Wait here.", voiceSettings: {}, held: [], parts: [] });
  });

  it("a sound a reader does not list is held by name, and two sounds may share a point", () => {
    const text = "Fine.";
    const both = plan(text, { cues: [{ kind: "sound", at: 5, sound: "sighs" }, { kind: "sound", at: 5, sound: "laughs" }] });
    assert.equal(mapCadence(text, hash(text), both, gemini).providerText, "Fine. <sigh> <laugh>");
    const cough = plan(text, { cues: [{ kind: "sound", at: 5, sound: "coughs" }] });
    assert.deepEqual(sentAs(text, cough, gemini).held, [{ control: "sound", cueIndex: 0, reason: "no coughs" }]);
    assert.throws(() => mapCadence(text, hash(text), plan(text, { cues: [{ kind: "sound", at: 5, sound: "sighs" }, { kind: "sound", at: 5, sound: "sighs" }] }), gemini), /Duplicate/);
  });

  it("a marker an instruction reader can only make in parts is named, so a one-request surface can hold it", () => {
    const text = "I’m here. You came back.";
    const marker = plan(text, { cues: [{ kind: "delivery", span: { from: 0, to: 9, text: "I’m here." }, delivery: "cold" }] });
    assert.deepEqual(sentAs(text, marker, gemini).parts, [0]);
  });

  it("the support report says what each sound, the note and a pause become on a row", () => {
    const g = cadenceSupport(gemini);
    assert.deepEqual(g.sounds.sighs, { status: "best-effort", method: "tag" });
    assert.deepEqual(g.sounds.coughs, { status: "unsupported", reason: "no coughs" });
    assert.deepEqual(g.note, { status: "best-effort", method: "instruction" });
    assert.deepEqual(g.pause, { status: "best-effort", method: "tag" });
    assert.deepEqual(cadenceSupport(elevenV2).pause, { status: "best-effort", method: "break" });
    assert.deepEqual(cadenceSupport(kokoro).pause, { status: "best-effort", method: "punctuation" });
    assert.deepEqual(cadenceSupport(kokoro).sounds.laughs, { status: "unsupported", reason: "no sounds" });
    assert.deepEqual(cadenceSupport(kokoro).note, { status: "unsupported", reason: "no note" });
  });
});

describe("typed and pasted tags become markers (181c)", () => {
  it("reads every reader's spelling as one marker, and names a bracket that is none", () => {
    const pasted = "[whispers] I’m here. <laugh> You came back (sighs) Say it [like a pirate] one more time.";
    const read = recogniseDirection(pasted);
    assert.equal(read.text, "I’m here. You came back Say it [like a pirate] one more time.");
    assert.deepEqual(read.cues, [
      { kind: "delivery", span: { from: 0, to: 9, text: "I’m here." }, delivery: "whispered" },
      { kind: "sound", at: 9, sound: "laughs" },
      { kind: "sound", at: 23, sound: "sighs" },
    ]);
    assert.deepEqual(read.unknown, [{ from: 31, to: 46, text: "[like a pirate]" }]);
    assert.equal(bracketNote(read.unknown[0]!.text), "like a pirate");
  });

  it("reads pauses, breath, emphasis and Eleven v2's break, and leaves a parenthetical as prose", () => {
    const read = recogniseDirection("Wait <short pause> here. <break time=\"1.5s\" /> [inhales deeply] It was (as I said) [emphasis] mine.");
    assert.equal(read.text, "Wait here. It was (as I said) mine.");
    assert.deepEqual(read.cues, [
      { kind: "pause", at: 4, length: "short" },
      { kind: "pause", at: 10, length: "long" },
      { kind: "breath", at: 10, action: "inhale" },
      { kind: "emphasis", span: { from: 30, to: 34, text: "mine" }, level: "strong" },
    ]);
    assert.deepEqual(read.unknown, [], "a parenthesis that names nothing is not a mistake");
  });

  it("a delivery runs to its sentence's end or the next delivery, and what it recognises maps", () => {
    const read = recogniseDirection("[coldly] Go. Now. [warmly] Come back");
    assert.deepEqual(read.cues.map((cue) => cue.kind === "delivery" ? [cue.delivery, cue.span.text] : null), [["cold", "Go."], ["warm", "Come back"]]);
    assert.doesNotThrow(() => mapCadence(read.text, hash(read.text), plan(read.text, { cues: read.cues }), gemini));
    assert.equal(directionWord("Throat-Clearing")?.kind, "sound");
    assert.equal(directionWord("like a pirate"), null);
  });

  it("orders cues and drops what would break a plan's rules, the first placed kept", () => {
    const kept = orderCues([
      { kind: "pause", at: 4, length: "long" },
      { kind: "pause", at: 4, length: "short" },
      { kind: "sound", at: 1, sound: "sighs" },
    ]);
    assert.deepEqual(kept, [{ kind: "sound", at: 1, sound: "sighs" }, { kind: "pause", at: 4, length: "long" }]);
  });
});
