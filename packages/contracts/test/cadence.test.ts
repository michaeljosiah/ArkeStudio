import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { cadenceSupport, seedCadencePlan, mapCadence, normalizeSpeechText, CadencePlanSchema, type CadencePlan, type ManifestModel } from "../src/index.js";
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const model: Pick<ManifestModel, "id" | "provider" | "cadence"> = { id: "test-v3", provider: "elevenlabs", cadence: {
  deliveries: ["measured"], speed: { min: 0.7, max: 1.2 }, pause: "best-effort-audio-tag", emphasis: "best-effort-capitalization",
  breath: "best-effort-audio-tag", outputTimestamps: "none", deliveryMappings: { measured: { settings: { stability: 0.5 } } } } };
const plan = (text: string, cues: CadencePlan["cues"] = []): CadencePlan => ({ schemaVersion: 1, sourceTextHash: hash(text), delivery: "measured", speed: 1, cues });
it("maps exact spans and tags at UTF-16 positions without modifying authored wording", () => {
  const text = "Straße waits.";
  const input = plan(text, [{ kind: "emphasis", span: { from: 0, to: 6, text: "Straße" }, level: "strong" },
    { kind: "pause", at: 6, length: "long" }, { kind: "breath", at: text.length, action: "exhale" }]);
  const output = mapCadence(text, hash(text), input, model);
  assert.equal(output.providerText, "STRASSE [long pause]  waits. [exhales] ");
  assert.equal(output.controls.length, 5); assert.equal(output.voiceSettings.speed, 1);
  assert.equal(normalizeSpeechText(" a\n b! "), "a b!");
});
it("refuses moved wording, surrogate splits, mismatched spans, overlap, duplicate and unordered cues", () => {
  const text = "Hi 😀 there";
  const bad: CadencePlan[] = [ { ...plan(text), sourceTextHash: hash("old") }, plan(text, [{ kind: "pause", at: 4, length: "short" }]),
    plan(text, [{ kind: "emphasis", span: { from: 0, to: 2, text: "No" }, level: "moderate" }]),
    plan(text, [{ kind: "pause", at: 2, length: "short" }, { kind: "pause", at: 2, length: "long" }]),
    plan(text, [{ kind: "pause", at: 5, length: "short" }, { kind: "pause", at: 0, length: "long" }]),
    plan(text, [{ kind: "emphasis", span: { from: 0, to: 2, text: "Hi" }, level: "strong" }, { kind: "emphasis", span: { from: 1, to: 2, text: "i" }, level: "strong" }]) ];
  for (const input of bad) assert.throws(() => mapCadence(text, hash(text), input, model));
});
it("names every unsupported control instead of silently claiming local cadence", () => {
  const text = "Hello";
  const output = mapCadence(text, hash(text), { ...plan(text, [{ kind: "breath", at: 0, action: "inhale" }]), speed: 1.1 },
    { id: "unknown", provider: "kokoro" });
  assert.deepEqual(output.controls.map(c => c.status), ["unsupported", "unsupported", "unsupported"]);
  assert.equal(output.providerText, text);
});

it("cadence seeding never transfers text offsets to different wording", () => {
  const source = plan("Wait here.", [{ kind: "pause", at: 4, length: "long" }]);
  const same = seedCadencePlan(source, "urgent", source.sourceTextHash);
  assert.deepEqual(same.cues, source.cues); assert.notEqual(same.cues, source.cues);
  const different = seedCadencePlan(source, "urgent", hash("Go."));
  assert.deepEqual(different.cues, []); assert.equal(different.delivery, "urgent");
  assert.equal(different.sourceTextHash, hash("Go."));
});

it("a paren row writes Breeze's tags and lifts the delivery's sentence out of the text (SPEC-046 R-21)", () => {
  const breeze: Pick<ManifestModel, "id" | "provider" | "cadence"> = { id: "breeze-tts-2", provider: "breezeblue", cadence: {
    deliveries: ["measured", "whispered", "breaking"], speed: { min: 0.7, max: 1.2 }, pause: "best-effort-audio-tag", emphasis: "unsupported",
    breath: "best-effort-audio-tag", outputTimestamps: "none", tagSyntax: "paren", deliveryMappings: {
      measured: { settings: { guidance_scale: 4 }, instruction: "Read it evenly." },
      whispered: { settings: { guidance_scale: 4 }, tag: "whispers" },
      breaking: { settings: { guidance_scale: 4 }, tag: "sobs", instruction: "The voice is breaking." } } } };
  const text = "Wait here.";
  const cues: CadencePlan["cues"] = [{ kind: "pause", at: 4, length: "long" }, { kind: "breath", at: text.length, action: "inhale" }];
  const whispered = mapCadence(text, hash(text), { ...plan(text, cues), delivery: "whispered" }, breeze, "en");
  assert.equal(whispered.providerText, "(whispers) Wait (pause)  here. (inhales) ");
  assert.equal(whispered.instructions, undefined);
  assert.equal(whispered.controls[0]?.status, "best-effort");
  const breaking = mapCadence(text, hash(text), { ...plan(text), delivery: "breaking" }, breeze, "en");
  assert.equal(breaking.providerText, "(sobs) Wait here.");
  assert.equal(breaking.instructions, "The voice is breaking.");
  assert.equal(breaking.controls[0]?.method, "instruction and declared settings");
  // The parentheses are English words (R-23): a line not stated to be English — a French clone,
  // or no language at all — gets the sentence and the untagged text, and each cue that would
  // have been a tag says why it is not.
  const french = mapCadence(text, hash(text), { ...plan(text, cues), delivery: "breaking" }, breeze, "fr");
  assert.equal(french.providerText, "Wait here.");
  assert.equal(french.instructions, "The voice is breaking.");
  assert.equal(french.controls[0]?.status, "best-effort");
  assert.deepEqual(french.controls.filter((c) => c.control === "pause" || c.control === "breath").map((c) => c.status), ["unsupported", "unsupported"]);
  assert.match(french.controls.find((c) => c.control === "pause")!.reason!, /not stated to be English/);
  const unstated = mapCadence(text, hash(text), { ...plan(text), delivery: "whispered" }, breeze);
  assert.equal(unstated.providerText, "Wait here.", "no language stated is not English");
  assert.equal(unstated.controls[0]?.status, "unsupported", "a tag-only delivery that cannot go in carries nothing");
  const measured = mapCadence(text, hash(text), plan(text), breeze);
  assert.equal(measured.providerText, "Wait here.");
  assert.equal(measured.instructions, "Read it evenly.");
  assert.deepEqual(measured.voiceSettings, { guidance_scale: 4, speed: 1 });
  // A bracket row is untouched by the syntax field's existence: the ElevenLabs rendering stands.
  const bracket = mapCadence(text, hash(text), plan(text, cues), model);
  assert.equal(bracket.providerText, "Wait [long pause]  here. [inhales deeply] ");
  assert.equal(bracket.instructions, undefined);
});

it("a Fish row carries the delivery as a bracket phrase in the text and nothing beside it (SPEC-046 §2.9)", () => {
  // Fish's S2 reads `[whispering]` as language: the same bracket ink as ElevenLabs' cues, with
  // the delivery's phrase in front of the line and no instruction field to lift it into.
  const fish: Pick<ManifestModel, "id" | "provider" | "cadence"> = { id: "fish-s2.1-pro", provider: "fishaudio", cadence: {
    deliveries: ["measured", "whispered", "breaking"], speed: { min: 0.7, max: 1.3 }, pause: "best-effort-audio-tag", emphasis: "unsupported",
    breath: "best-effort-audio-tag", outputTimestamps: "none", deliveryMappings: {
      measured: { settings: {}, tag: "calm and even" },
      whispered: { settings: {}, tag: "whispering" },
      breaking: { settings: {}, tag: "voice breaking, through tears" } } } };
  const text = "Wait here.";
  const cues: CadencePlan["cues"] = [{ kind: "pause", at: 4, length: "long" }];
  const whispered = mapCadence(text, hash(text), { ...plan(text, cues), delivery: "whispered" }, fish);
  assert.equal(whispered.providerText, "[whispering] Wait [long pause]  here.");
  assert.equal(whispered.instructions, undefined);
  assert.equal(whispered.controls[0]?.status, "best-effort");
  assert.equal(whispered.controls[0]?.method, "audio tag and declared settings");
  assert.deepEqual(whispered.voiceSettings, { speed: 1 });
  const breaking = mapCadence(text, hash(text), { ...plan(text), delivery: "breaking", speed: 0.8 }, fish);
  assert.equal(breaking.providerText, "[voice breaking, through tears] Wait here.");
  assert.deepEqual(breaking.voiceSettings, { speed: 0.8 });
});

it("a phrase rides the row's seam — a tag, an instruction, or refused — and is never spoken words (SPEC-047 R-7)", () => {
  const text = "Wait here.";
  const tagRow: Pick<ManifestModel, "id" | "provider" | "cadence"> = { id: "fish-s2.1-pro", provider: "fishaudio", cadence: {
    deliveries: ["measured", "whispered"], speed: { min: 0.7, max: 1.3 }, pause: "best-effort-audio-tag", emphasis: "unsupported",
    breath: "best-effort-audio-tag", outputTimestamps: "none", phrase: "best-effort-tag",
    deliveryMappings: { measured: { settings: {}, tag: "calm and even" }, whispered: { settings: {}, tag: "whispering" } } } };
  const tagged = mapCadence(text, hash(text), { ...plan(text), delivery: "whispered", phrase: "to the water, flat" }, tagRow);
  assert.equal(tagged.providerText, "[whispering] [to the water, flat] Wait here.", "after the delivery's tag, in the row's ink");
  assert.deepEqual(tagged.controls.find((c) => c.control === "phrase"), { control: "phrase", status: "best-effort", method: "audio tag" });
  const instructionRow: Pick<ManifestModel, "id" | "provider" | "cadence"> = { id: "breeze-tts-2", provider: "breezeblue", cadence: {
    deliveries: ["measured"], speed: { min: 0.7, max: 1.2 }, pause: "best-effort-audio-tag", emphasis: "unsupported",
    breath: "best-effort-audio-tag", outputTimestamps: "none", tagSyntax: "paren", phrase: "best-effort-instruction",
    deliveryMappings: { measured: { settings: { guidance_scale: 4 }, instruction: "Read it evenly." } } } };
  const instructed = mapCadence(text, hash(text), { ...plan(text), phrase: "To the water, flat." }, instructionRow, "fr");
  assert.equal(instructed.providerText, "Wait here.", "nothing of the phrase in the words, whatever the language");
  assert.equal(instructed.instructions, "Read it evenly. To the water, flat.");
  assert.deepEqual(instructed.controls.find((c) => c.control === "phrase"), { control: "phrase", status: "best-effort", method: "instruction" });
  const refused = mapCadence(text, hash(text), { ...plan(text), phrase: "flat" }, model);
  assert.equal(refused.providerText, "Wait here.");
  assert.equal(refused.controls.find((c) => c.control === "phrase")?.status, "unsupported", "a row that declares nothing takes no phrase");
  assert.equal(mapCadence(text, hash(text), plan(text), tagRow).controls.some((c) => c.control === "phrase"), false, "no phrase, no control to report");
  assert.ok(!CadencePlanSchema.safeParse({ ...plan(text), phrase: "x".repeat(61) }).success, "the phrase is at most 60 characters");
  assert.ok(!CadencePlanSchema.safeParse({ ...plan(text), phrase: "" }).success);
});

it("the support report reads off the row what each control would do, one clause where it cannot (SPEC-047 R-9)", () => {
  const kokoro = cadenceSupport({ cadence: { deliveries: ["measured", "urgent"], speed: null, pause: "unsupported", emphasis: "unsupported", breath: "unsupported",
    outputTimestamps: "none", deliveryMappings: { measured: { settings: { speed: 0.92 } }, urgent: { settings: { speed: 1.15 } } } } });
  assert.deepEqual(kokoro.deliveries["measured"], { status: "mapped", method: "settings" });
  assert.deepEqual(kokoro.deliveries["whispered"], { status: "unsupported", reason: "reads measured · urgent" });
  assert.deepEqual(kokoro.speed, { status: "unsupported", reason: "no speed" });
  assert.deepEqual(kokoro.pause, { status: "unsupported", reason: "no pause" });
  assert.deepEqual(kokoro.phrase, { status: "unsupported", reason: "no phrase" });
  const eleven = cadenceSupport(model);
  assert.deepEqual(eleven.pause, { status: "best-effort", method: "tag" });
  assert.deepEqual(eleven.emphasis, { status: "best-effort", method: "capitals" });
  assert.deepEqual(eleven.speed, { status: "mapped", method: "0.7–1.2" });
  assert.deepEqual(cadenceSupport({}).deliveries["measured"], { status: "unsupported", reason: "no delivery" }, "a row with no cadence at all");
  // A paren row's tags are English words (SPEC-046 R-23): offered only for a line stated English.
  const breeze: Pick<ManifestModel, "cadence"> = { cadence: { deliveries: ["measured", "whispered", "breaking"], speed: { min: 0.7, max: 1.2 }, pause: "best-effort-audio-tag",
    emphasis: "unsupported", breath: "best-effort-audio-tag", outputTimestamps: "none", tagSyntax: "paren", phrase: "best-effort-instruction",
    deliveryMappings: { measured: { settings: {}, instruction: "Read it evenly." }, whispered: { settings: {}, tag: "whispers" }, breaking: { settings: {}, tag: "sobs", instruction: "The voice is breaking." } } } };
  const french = cadenceSupport(breeze, "fr");
  assert.deepEqual(french.pause, { status: "unsupported", reason: "tags need a line stated English" });
  assert.deepEqual(french.deliveries["whispered"], { status: "unsupported", reason: "tags need a line stated English" }, "a tag-only delivery cannot go in");
  assert.deepEqual(french.deliveries["breaking"], { status: "best-effort", method: "instruction" }, "the sentence carries it whatever the language");
  assert.deepEqual(french.phrase, { status: "best-effort", method: "instruction" });
  assert.deepEqual(cadenceSupport(breeze).pause, { status: "unsupported", reason: "tags need a line stated English" }, "no language stated is not English");
  assert.deepEqual(cadenceSupport(breeze, "en").pause, { status: "best-effort", method: "tag" });
  assert.deepEqual(cadenceSupport(breeze, "en").deliveries["whispered"], { status: "best-effort", method: "tag" });
});
