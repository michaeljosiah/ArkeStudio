import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CadenceCapabilitiesSchema, GROUPED_READ_CAPS, groupedText, groupReads, packTurns, quoteGroupedSpeech, quoteSpeech, readerGroups, shareByCharacters, soloTurns, turnInputTokens,
  type BlockTurns, type CadenceCapabilities, type ManifestModel } from "../src/index.js";

const model: ManifestModel = {
  id: "gemini-3.8-flash-tts", provider: "google", capability: "voice-tts", displayName: "Gemini Flash",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: {},
  pricing: { kind: "perToken", microUsdPerMillionInput: 500_000, microUsdPerMillionOutput: 9_000_000,
    speech: { tier: "standard", maxInputTokens: 8192, maxOutputTokens: 16384, audioTokensPerSecond: 25,
      rates: [{ version: "intro", effectiveFrom: "2026-09-27T00:00:00.000Z", microUsdPerMillionInput: 500_000, microUsdPerMillionOutput: 9_000_000 }] } },
};
const NOTES = "Nigerian English, unhurried and close. Victoria Island, after midnight.";
const words = (count: number) => Array.from({ length: count }, (_, i) => `word${i}`).join(" ");
const block = (key: string, count: number, over: Partial<BlockTurns> = {}): BlockTurns =>
  ({ key, reader: "google/flash/ife", shared: NOTES, parts: [{ text: words(count) }], ...over });

describe("grouped reads (design turn 185)", () => {
  it("sends the notes once and each later turn only its own direction, and merges a run under one direction", () => {
    const blocks: BlockTurns[] = [
      { key: "p1.0", reader: "r", shared: NOTES, parts: [{ text: "Tunde was telling the goat story again." }] },
      { key: "p2.0", reader: "r", shared: NOTES, parts: [{ text: "“It is not possible,”", style: "Ade, dry and amused." }] },
      { key: "p2.1", reader: "r", shared: NOTES, parts: [{ text: "Ade said." }] },
      { key: "p3.0", reader: "r", shared: NOTES, parts: [{ text: "Nobody laughed." }] },
    ];
    assert.deepEqual(packTurns(blocks, "full").map((turn) => turn.instructions), [NOTES, `${NOTES} Ade, dry and amused.`, NOTES, NOTES]);
    assert.deepEqual(packTurns(blocks, "deltas").map((turn) => turn.instructions), [NOTES, "Ade, dry and amused.", undefined, undefined]);
    const merged = packTurns(blocks, "merged");
    assert.deepEqual(merged.map((turn) => [turn.text, turn.instructions, turn.keys]), [
      ["Tunde was telling the goat story again.", NOTES, ["p1.0"]],
      ["“It is not possible,”", "Ade, dry and amused.", ["p2.0"]],
      ["Ade said.\nNobody laughed.", undefined, ["p2.1", "p3.0"]],
    ]);
    // A solo read keeps its whole style: the notes ahead of the block's own.
    assert.deepEqual(soloTurns(blocks[1]!), [{ text: "“It is not possible,”", instructions: `${NOTES} Ade, dry and amused.` }]);
    // Notes that change inside a request ride again where they change.
    const changed = packTurns([blocks[0]!, { ...blocks[3]!, shared: "Another chapter." }], "deltas");
    assert.deepEqual(changed.map((turn) => turn.instructions), [NOTES, "Another chapter."]);
  });

  it("packs consecutive blocks of one reader, and a block not sent or another reader closes the request", () => {
    const groups = groupReads([block("a", 10), block("b", 10), null, block("c", 10), block("d", 10, { reader: "ade" }), block("e", 10, { reader: "ade" }), block("f", 10)]);
    assert.deepEqual(groups.map((group) => group.keys), [["a", "b"], ["c"], ["d", "e"], ["f"]]);
  });

  it("closes at about five minutes, at the latest natural break: a scene break first, else a narration paragraph's end", () => {
    // 150 words a minute: 100 words is 40 s, so seven fit in five minutes.
    const plain = Array.from({ length: 16 }, (_, i) => block(`s${i}`, 100));
    assert.deepEqual(groupReads(plain).map((group) => group.keys.length), [7, 7, 2], "no break at all: cut where the caps fall");
    const broken = Array.from({ length: 16 }, (_, i) => block(`s${i}`, 100, i === 2 ? { breakAfter: "scene" } : i === 4 ? { breakAfter: "paragraph" } : {}));
    assert.deepEqual(groupReads(broken)[0]!.keys, ["s0", "s1", "s2"], "the scene break wins over a later paragraph's end");
    const paragraphs = Array.from({ length: 16 }, (_, i) => block(`s${i}`, 100, i === 1 || i === 4 ? { breakAfter: "paragraph" } : {}));
    assert.deepEqual(groupReads(paragraphs)[0]!.keys, ["s0", "s1", "s2", "s3", "s4"], "the latest narration paragraph under the caps");
    for (const group of [...groupReads(plain), ...groupReads(broken), ...groupReads(paragraphs)]) assert.ok(group.seconds <= GROUPED_READ_CAPS.speechSeconds);
    assert.equal(groupReads(broken).reduce((sum, group) => sum + group.keys.length, 0), 16, "every block in exactly one request");
  });

  it("counts the notes once under deltas, so far more blocks fit a request than with full style", () => {
    const styled = Array.from({ length: 120 }, (_, i) => block(`t${i}`, 5, { shared: "n".repeat(1_200) }));
    const full = groupReads(styled, "full");
    const deltas = groupReads(styled, "deltas");
    assert.ok(full.every((group) => group.inputTokens <= GROUPED_READ_CAPS.inputTokens));
    assert.ok(deltas.length < full.length);
    assert.equal(deltas.reduce((sum, group) => sum + group.keys.length, 0), 120);
  });

  it("sends a block over the caps alone", () => {
    const groups = groupReads([block("a", 5), block("h", 1_000), block("z", 5)]);
    assert.deepEqual(groups.map((group) => group.keys), [["a"], ["h"], ["z"]]);
  });

  it("counts each turn's style in its input and prices a request once, its words and every style", () => {
    assert.ok(turnInputTokens({ text: "Hello.", instructions: "x".repeat(400) }) > turnInputTokens({ text: "Hello." }) + 99);
    const turns = [{ text: "First block.", instructions: "Whisper." }, { text: "Second block." }];
    const at = "2026-10-03T00:00:00.000Z";
    const quote = quoteGroupedSpeech(model, turns, { at });
    assert.equal(groupedText(turns), "First block. Second block.");
    assert.deepEqual(quote, quoteSpeech(model, "First block. Second block.", { at, instructions: "Whisper." }));
    // One lead-in and tail for the request, not one a block: two blocks priced together cost less than apart.
    const apart = turns.reduce((sum, turn) => sum + quoteSpeech(model, turn.text, { at, ...(turn.instructions ? { instructions: turn.instructions } : {}) }).expectedMicroUsd, 0);
    assert.ok(quote.expectedMicroUsd < apart);
    assert.equal(quote.authorisedMicroUsd, quoteSpeech(model, "x", { at }).authorisedMicroUsd, "authorised per request at the service limits");
  });

  it("shares a request's cost by characters, in whole micro-dollars that sum to the request", () => {
    assert.deepEqual(shareByCharacters(100, [1, 1, 1]), [34, 33, 33]);
    assert.deepEqual(shareByCharacters(7, [10, 30]), [2, 5]);
    assert.deepEqual(shareByCharacters(null, [10, 30]), [null, null]);
    assert.deepEqual(shareByCharacters(5, [0, 0]), [5, 0]);
    for (const total of [0, 1, 999, 4_603]) {
      const shares = shareByCharacters(total, [37, 120, 3, 58, 9]) as number[];
      assert.equal(shares.reduce((sum, share) => sum + share, 0), total);
    }
  });

  it("groups only a token-priced reader whose cadence row says so; every row is per paragraph by default", () => {
    const cadence: CadenceCapabilities = { deliveries: [], speed: null, pause: "unsupported", emphasis: "unsupported", breath: "unsupported", outputTimestamps: "none", deliveryMappings: {} };
    assert.equal(readerGroups({ ...model, cadence }), false);
    assert.equal(readerGroups({ ...model, cadence: { ...cadence, groupable: true } }), true);
    assert.equal(readerGroups({ ...model, pricing: { kind: "unmetered" }, cadence: { ...cadence, groupable: true } }), false);
    assert.equal(CadenceCapabilitiesSchema.safeParse({ ...cadence, groupable: false }).success, false, "absent is off; there is no explicit false");
  });
});
