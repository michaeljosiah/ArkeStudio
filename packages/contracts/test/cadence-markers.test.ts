import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { audiobookDirectionHash, audiobookRekeyed, holdDirection, mapCadence, markerMode, markerSegments, rekeyCues, type CadencePlan, type ManifestModel } from "../src/index.js";

// Delivery markers (SPEC-047 R-40..R-43): direction over a span inside a block.
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
type Row = Pick<ManifestModel, "id" | "provider" | "cadence">;
const plan = (text: string, cues: CadencePlan["cues"] = [], extra: Partial<CadencePlan> = {}): CadencePlan => ({ schemaVersion: 1, sourceTextHash: hash(text), delivery: "measured", speed: 1, cues, ...extra });
const fish: Row = { id: "fish-s2.1-pro", provider: "fishaudio", cadence: {
  deliveries: ["measured", "whispered", "cold"], speed: { min: 0.7, max: 1.3 }, pause: "best-effort-audio-tag", emphasis: "unsupported",
  breath: "best-effort-audio-tag", outputTimestamps: "none", phrase: "best-effort-tag",
  deliveryMappings: { measured: { settings: {}, tag: "calm and even" }, whispered: { settings: {}, tag: "whispering" }, cold: { settings: {}, tag: "coldly" } } } };
const eleven: Row = { id: "eleven-v3", provider: "elevenlabs", cadence: {
  deliveries: ["measured", "whispered"], speed: { min: 0.7, max: 1.2 }, pause: "best-effort-audio-tag", emphasis: "best-effort-capitalization",
  breath: "best-effort-audio-tag", outputTimestamps: "none", phrase: "best-effort-tag",
  deliveryMappings: { measured: { settings: { stability: 0.5 } }, whispered: { settings: { stability: 0.3 }, tag: "whispers" } } } };
const kokoro: Row = { id: "kokoro-82m", provider: "kokoro", cadence: {
  deliveries: ["measured", "urgent"], speed: null, pause: "unsupported", emphasis: "unsupported", breath: "unsupported", outputTimestamps: "none",
  deliveryMappings: { measured: { settings: { speed: 0.92 } }, urgent: { settings: { speed: 1.15 } } } } };
const text = "She leaned in. Not tonight, she said.";
const span = (words: string) => ({ from: text.indexOf(words), to: text.indexOf(words) + words.length, text: words });

it("a marker on a tag row is a tag before its span and the block's own tag after it (R-41)", () => {
  const input = plan(text, [{ kind: "delivery", span: span("Not tonight,"), delivery: "whispered" }]);
  const mapped = mapCadence(text, hash(text), input, fish);
  assert.equal(mapped.providerText, "[calm and even] She leaned in. [whispering] Not tonight, [calm and even] she said.");
  assert.deepEqual(mapped.controls.find((c) => c.cueIndex === 0), { control: "delivery", cueIndex: 0, status: "best-effort", method: "audio tag" });
  const phrased = mapCadence(text, hash(text), plan(text, [{ kind: "delivery", span: span("Not tonight,"), phrase: "barely there" }]), fish);
  assert.equal(phrased.providerText, "[calm and even] She leaned in. [barely there] Not tonight, [calm and even] she said.", "a phrase alone keeps the block's delivery");
});

it("a marker the block cannot be restored after is made in parts, and one at the block's end stays inline", () => {
  // ElevenLabs' measured has no tag: `[whispers]` would run on into the narration after it.
  const middle = plan(text, [{ kind: "delivery", span: span("Not tonight,"), delivery: "whispered" }]);
  assert.deepEqual(markerMode(middle.cues[0] as never, middle, eleven, undefined, text.length), { mode: "parts" });
  const segments = markerSegments(text, middle, eleven);
  assert.deepEqual(segments.map((s) => [s.text, s.plan.delivery]), [["She leaned in.", "measured"], ["Not tonight,", "whispered"], ["she said.", "measured"]]);
  const end = plan(text, [{ kind: "delivery", span: span("she said."), delivery: "whispered" }]);
  assert.equal(mapCadence(text, hash(text), end, eleven).providerText, "She leaned in. Not tonight, [whispers] she said.");
  assert.equal(markerSegments(text, end, eleven).length, 1);
});

it("a settings-only row makes a marker in parts, each with its own delivery and the cues that fall in it", () => {
  const input = plan(text, [
    { kind: "pause", at: 14, length: "short" },
    { kind: "delivery", span: span("Not tonight,"), delivery: "urgent" },
  ]);
  const mapped = mapCadence(text, hash(text), input, kokoro);
  assert.equal(mapped.providerText, text, "the parts are the caller's; the whole block's words are untouched");
  assert.equal(mapped.controls.find((c) => c.cueIndex === 1)?.method, "parts");
  const segments = markerSegments(text, input, kokoro);
  assert.deepEqual(segments.map((s) => s.plan.delivery), ["measured", "urgent", "measured"]);
  assert.deepEqual(segments[0]!.plan.cues, [{ kind: "pause", at: 14, length: "short" }], "the pause stays with the words before it, once");
  assert.deepEqual(segments[1]!.plan.cues, []);
  assert.equal(segments.map((s) => s.text).join(" "), text);
});

it("an emphasis inside a marker is allowed, one across its edge is not, and a marker needs a delivery or a phrase", () => {
  const inside = plan(text, [{ kind: "delivery", span: span("Not tonight,"), delivery: "whispered" }, { kind: "emphasis", span: span("tonight"), level: "strong" }]);
  assert.equal(mapCadence(text, hash(text), inside, eleven).controls.length > 0, true);
  const across = plan(text, [{ kind: "delivery", span: span("Not tonight,"), delivery: "whispered" }, { kind: "emphasis", span: span("tonight, she"), level: "strong" }]);
  assert.throws(() => mapCadence(text, hash(text), across, eleven), /inside a marker or outside it/);
  const empty = plan(text, [{ kind: "delivery", span: span("Not tonight,") }]);
  assert.throws(() => mapCadence(text, hash(text), empty, eleven), /delivery or a phrase/);
  const overlap = plan(text, [{ kind: "delivery", span: span("Not tonight,"), delivery: "whispered" }, { kind: "delivery", span: span("tonight, she"), delivery: "cold" }]);
  assert.throws(() => mapCadence(text, hash(text), overlap, fish), /non-overlapping/);
  const wrong = plan(text, [{ kind: "delivery", span: { ...span("Not tonight,"), text: "Not today," }, delivery: "whispered" }]);
  assert.throws(() => mapCadence(text, hash(text), wrong, fish));
});

it("what a reader cannot express is held: left out of what is sent, named, and kept on the plan (R-47)", () => {
  const input = plan(text, [{ kind: "pause", at: 14, length: "long" }, { kind: "delivery", span: span("Not tonight,"), delivery: "whispered" }], { phrase: "tired", speed: 1.1 });
  const { plan: sent, held } = holdDirection(text, input, kokoro);
  assert.deepEqual(held.map((h) => [h.control, h.cueIndex]), [["speed", undefined], ["pause", 0], ["marker", 1], ["phrase", undefined]]);
  assert.equal(held.find((h) => h.control === "marker")?.reason, "reads measured · urgent");
  assert.deepEqual(sent.cues, []);
  assert.equal(sent.phrase, undefined);
  assert.equal(sent.speed, 1);
  assert.equal(holdDirection(text, input, fish).held.length, 0, "a reader that can express it holds nothing");
});

it("a marker is part of the direction's name, so adding one makes the block stale", () => {
  const bare = plan(text);
  const marked = plan(text, [{ kind: "delivery", span: span("Not tonight,"), delivery: "whispered" }]);
  const phrased = plan(text, [{ kind: "delivery", span: span("Not tonight,"), delivery: "whispered", phrase: "close" }]);
  assert.notEqual(audiobookDirectionHash(bare), audiobookDirectionHash(marked));
  assert.notEqual(audiobookDirectionHash(marked), audiobookDirectionHash(phrased));
});

it("changed wording carries each cue whose anchor is found once, and counts the rest (R-43)", () => {
  const before = "She leaned in. Not tonight, she said. Then she left.";
  const after = "She leaned closer. Not tonight, she said softly. Then she left.";
  const cues: CadencePlan["cues"] = [
    { kind: "pause", at: before.indexOf(" Not"), length: "short" },
    { kind: "delivery", span: { from: before.indexOf("Not tonight,"), to: before.indexOf("Not tonight,") + 12, text: "Not tonight," }, delivery: "whispered" },
    { kind: "breath", at: before.indexOf("Then"), action: "inhale" },
    { kind: "emphasis", span: { from: before.indexOf("she said"), to: before.indexOf("she said") + 8, text: "she said" }, level: "strong" },
  ];
  const { cues: moved, dropped } = rekeyCues(before, cues, after);
  // `in.` is gone, so the pause after it goes; `said.` is now `softly.`, so the breath's anchor
  // is gone too; the marker and the emphasis are found once each.
  assert.equal(dropped, 2);
  assert.deepEqual(moved.map((c) => c.kind), ["delivery", "emphasis"]);
  const marker = moved[0] as Extract<CadencePlan["cues"][number], { kind: "delivery" }>;
  assert.equal(after.slice(marker.span.from, marker.span.to), "Not tonight,");
  const twice = rekeyCues("Go now.", [{ kind: "emphasis", span: { from: 0, to: 2, text: "Go" }, level: "strong" }], "Go on, go now. Go.");
  assert.equal(twice.dropped, 1, "an anchor found twice is not guessed between");
  const start = rekeyCues("Wait here.", [{ kind: "pause", at: 0, length: "long" }], "Please. Wait here.");
  assert.deepEqual(start.cues, [{ kind: "pause", at: 8, length: "long" }], "a cue at the start is anchored by the word after it");
});

it("a direction that kept its words is carried to new ones; one from an earlier build is not", () => {
  const before = "Not tonight, she said.";
  const direction = {
    textHash: "old",
    plan: plan(before, [{ kind: "delivery", span: { from: 0, to: 12, text: "Not tonight," }, delivery: "whispered" }], { delivery: "cold", phrase: "flat" }),
    at: "2026-09-26T00:00:00.000Z",
    text: before,
  };
  const block = { key: "p1.1", text: "Not tonight, she whispered." };
  const carried = audiobookRekeyed({ direction: { "p1.1": direction } }, block);
  assert.equal(carried?.dropped, 0);
  assert.equal(carried?.input.delivery, "cold");
  assert.equal(carried?.input.phrase, "flat");
  assert.equal(carried?.input.cues.length, 1);
  const { text: _gone, ...earlier } = direction;
  assert.equal(audiobookRekeyed({ direction: { "p1.1": earlier } }, block), null);
});
