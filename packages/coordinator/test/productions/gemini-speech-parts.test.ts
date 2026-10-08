import assert from "node:assert/strict";
import { it } from "node:test";
import { mapCadence, normalizeSpeechText, quoteSpeech, speechInputFits, type CadencePlan } from "@arke-studio/contracts";
import { geminiSpeechModel } from "@arke-studio/providers";
import { checkDirection, directionPlan, directionSourceHash } from "../../src/voice/direction.js";
import { piecesFor } from "../../src/voice/pieces.js";

it("keeps Gemini delivery and note out of spoken words, restores block style after a span", () => {
  const text = "The door opened. Stay here. She left.";
  for (const variant of ["flash", "lite"] as const) {
    const model = geminiSpeechModel(variant);
    const start = text.indexOf("Stay here.");
    const plan: CadencePlan = { schemaVersion: 1, sourceTextHash: directionSourceHash(text), delivery: "warm", speed: 1, note: "gently reassuring",
      cues: [{ kind: "delivery", span: { from: start, to: start + 10, text: "Stay here." }, delivery: "whispered", phrase: "quiet urgency" }] };
    const check = checkDirection(text, plan, model);
    assert.ok(check.ok);
    assert.deepEqual(check.parts.map(p => p.text), ["The door opened.", "Stay here.", "She left."]);
    assert.deepEqual(check.parts.map(p => p.instructions), ["Warm and gentle. Gently reassuring.", "Whispering. Quiet urgency.", "Warm and gentle. Gently reassuring."]);
    assert.ok(check.parts.every(p => Object.keys(p.voiceSettings).length === 0));
    assert.equal(check.mapped.controls.find(c => c.control === "delivery")?.status, "best-effort");
  }
});

it("packs long CJK and emoji passages including style before pricing each request", () => {
  const text = normalizeSpeechText("海から船が来た。 😀 The tide turned. ".repeat(250));
  const model = geminiSpeechModel("flash");
  const plan = directionPlan(text, { delivery: "warm", speed: 1, cues: [], note: "穏やかに" });
  const check = checkDirection(text, plan, model);
  assert.ok(check.ok);
  assert.ok(check.parts.length > 1);
  assert.equal(check.parts.map(p => p.text).join(" "), text);
  assert.ok(check.parts.every(p => speechInputFits(p.text, model.limits, p.instructions)));
  assert.ok(check.parts.every(p => p.instructions === "Warm and gentle. 穏やかに"));
  const quotes = check.parts.map(p => quoteSpeech(model, p.text, { at: "2026-09-27T12:00:00Z" }));
  assert.equal(quotes.reduce((sum, q) => sum + q.authorisedMicroUsd, 0), check.parts.length * 151552);
  const plain = piecesFor(text, model, "wav");
  assert.equal(plain.join(" "), text);
  assert.ok(plain.every(p => speechInputFits(p, model.limits)));
});

it("holds an unsupported speed without corrupting the authored plan, and sends the pause Gemini 3.8 reads", () => {
  const model = geminiSpeechModel("lite");
  const text = "Wait here.";
  const plan = directionPlan(text, { delivery: "cold", speed: 0.7, cues: [{ kind: "pause", at: 4, length: "long" }] });
  assert.equal(checkDirection(text, plan, model).ok, false);
  const held = checkDirection(text, plan, model, undefined, "hold");
  assert.ok(held.ok);
  assert.deepEqual(held.held.map(c => c.control), ["speed"]);
  assert.equal(held.parts[0]?.text, "Wait <long pause> here.", "a pause in Gemini's own angle brackets (design turn 181)");
  assert.equal(plan.speed, 0.7);
  assert.equal(plan.cues.length, 1);
});

it("refuses a direction that cannot fit and does not drop a span cut by a byte boundary", () => {
  const text = "A long emphatic statement.";
  const model = geminiSpeechModel("flash");
  model.limits.maxSpeechUtf8Bytes = 10;
  const check = checkDirection(text, directionPlan(text, { delivery: "warm", speed: 1, cues: [] }), model);
  assert.ok(!check.ok);
  assert.match(check.reason, /no room|cannot fit/);
  // A future qualified emphasis mapping must still refuse a split which loses its anchor.
  model.limits.maxSpeechUtf8Bytes = 60;
  model.cadence!.emphasis = "best-effort-capitalization";
  const plan = directionPlan(text, { delivery: "warm", speed: 1, note: "keep it gentle", cues: [{ kind: "emphasis", span: { from: 2, to: text.length, text: text.slice(2) }, level: "strong" }] });
  assert.equal(mapCadence(text, plan.sourceTextHash, plan, model).providerText, "A LONG EMPHATIC STATEMENT.");
  const split = checkDirection(text, plan, model);
  assert.ok(!split.ok);
  assert.match(split.reason, /straddles/);
});

it("honours combined character/byte caps without splitting surrogate pairs", () => {
  const text = "😀海".repeat(12);
  const model = geminiSpeechModel("lite");
  model.limits.maxPromptChars = 5;
  model.limits.maxSpeechUtf8Bytes = 52;
  const check = checkDirection(text, directionPlan(text, { delivery: "warm", speed: 1, cues: [] }), model);
  assert.ok(check.ok);
  assert.equal(check.parts.map(p => p.text).join(""), text);
  assert.ok(check.parts.every(p => speechInputFits(p.text, model.limits, p.instructions)));
  assert.ok(check.parts.every(p => !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(p.text)));
});

it("renders a point cue once when recursive packing places it on a request boundary", () => {
  const model = geminiSpeechModel("flash");
  // Exercise the generic packer's point handling with a breath, which Gemini 3.8 reads as
  // `<exhales>` (design turn 181).
  model.cadence!.deliveryMappings.measured = { settings: {} };
  model.limits.maxSpeechUtf8Bytes = 17;
  const text = "a".repeat(17) + "b".repeat(15);
  const check = checkDirection(text, directionPlan(text, { delivery: "measured", speed: 1, cues: [{ kind: "breath", at: 17, action: "exhale" }] }), model);
  assert.ok(check.ok);
  const rendered = check.parts.map(p => p.text).join("");
  assert.equal(rendered.split("<exhales>").length - 1, 1);
  assert.equal(rendered.replace("<exhales>", "").replaceAll(" ", ""), text);
  assert.ok(check.parts.every(p => speechInputFits(p.text, model.limits, p.instructions)));
});
