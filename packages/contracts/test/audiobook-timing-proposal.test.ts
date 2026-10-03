import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { audiobookTextHash } from "../src/audiobook.js";
import { applyTimingProposal, breaksOff, proposalCounts, proposeTiming, type ProposalBlock } from "../src/audiobook-timing-proposal.js";
import type { BlockTiming, ChapterTimingRecord } from "../src/audiobook-timing.js";

/**
 * Propose timing (design turn 187b, SPEC-047 R-86): read off the chapter — a line that breaks off
 * with a dash is cut into, an exchange runs tight, a scene break and the heading are let breathe,
 * a reaction the narration names is put under the line beside it, a bed the words name — and
 * never over the author's timing, which is counted as kept.
 */

const AT = "2026-10-03T15:00:00.000Z";
const PARAGRAPHS = [
  "Tunde was telling the goat story again.",
  "“Ade, I am telling you. The goat looked at me like this —”",
  "“Tunde —”",
  "Tunde laughed and leaned back into the club's purple light.",
  "“The goat was in the boot.”",
  "* * *",
  "Read. No reply.",
  "Ade stood up.",
];
const BLOCKS: ProposalBlock[] = [
  { key: "title", text: "Chapter 1 · The Goat", paragraph: -1, speaker: null, name: null, take: { seconds: 2, tail: 0.3 } },
  { key: "p0.0", text: PARAGRAPHS[0]!, paragraph: 0, speaker: null, name: null, take: { seconds: 2.4, tail: 0.3 } },
  { key: "p1.0", text: PARAGRAPHS[1]!, paragraph: 1, speaker: "tunde", name: "Tunde", take: { seconds: 3, tail: 0.5 } },
  { key: "p2.0", text: PARAGRAPHS[2]!, paragraph: 2, speaker: "ade", name: "Ade", take: { seconds: 1.6, tail: 0.6 } },
  { key: "p3.0", text: PARAGRAPHS[3]!, paragraph: 3, speaker: null, name: null, take: { seconds: 3, tail: 0.3 } },
  { key: "p4.0", text: PARAGRAPHS[4]!, paragraph: 4, speaker: "ade", name: "Ade", take: { seconds: 2, tail: 0.3 } },
  { key: "p6.0", text: PARAGRAPHS[6]!, paragraph: 6, speaker: null, name: null, take: { seconds: 1.5 } },
  { key: "p7.0", text: PARAGRAPHS[7]!, paragraph: 7, speaker: null, name: null, take: { seconds: 1.2 } },
];
const SOUNDS = [{ file: "artifacts/club-amapiano.wav", origin: "world" as const, label: "club amapiano", seconds: 200 }];
const author = (key: string, entry: Partial<BlockTiming>): BlockTiming => ({ textHash: audiobookTextHash(BLOCKS.find((block) => block.key === key)!.text), by: "author", at: AT, ...entry });

describe("Arke proposes timing (turn 187b)", () => {
  it("knows a line that breaks off", () => {
    assert.ok(breaksOff("“The goat looked at me like this —”"));
    assert.ok(breaksOff("He said--"));
    assert.equal(breaksOff("“The goat was in the boot.”"), false);
  });

  it("cuts the next speaker in where a line breaks off, timed by where its words stop", () => {
    const proposal = proposeTiming({ blocks: BLOCKS, paragraphs: PARAGRAPHS, record: null, sounds: [] });
    assert.deepEqual(proposal.starts["p2.0"], { start: -0.6, why: "cuts in" }, "the half second of quiet after the dash taken back, and a little more");
    assert.deepEqual(proposal.starts["p0.0"], { start: 1, why: "heading" });
    assert.deepEqual(proposal.starts["p6.0"], { start: 1.5, why: "scene" });
    assert.deepEqual(proposal.starts["p7.0"], { start: 0.6, why: "pause" }, "a short last line is let sit");
    assert.equal(proposal.heard, 6);
  });

  it("puts the reaction the narration names under the line beside it", () => {
    const proposal = proposeTiming({ blocks: BLOCKS, paragraphs: PARAGRAPHS, record: null, sounds: [] });
    assert.deepEqual(proposal.reactions, [{ host: "p2.0", speaker: "tunde", sound: "laughs", offset: 0.65 }]);
  });

  it("proposes a bed the words name, to the end of its scene", () => {
    const proposal = proposeTiming({ blocks: BLOCKS, paragraphs: PARAGRAPHS, record: null, sounds: SOUNDS });
    assert.equal(proposal.beds.length, 1);
    assert.deepEqual([proposal.beds[0]!.from, proposal.beds[0]!.to, proposal.beds[0]!.levelDb, proposal.beds[0]!.duckDb], ["p3.0", "p4.0", -14, 10]);
  });

  it("never moves the author's timing, and counts it as kept", () => {
    const record = { timing: { "p2.0": author("p2.0", { start: 0.2 }) } };
    const proposal = proposeTiming({ blocks: BLOCKS, paragraphs: PARAGRAPHS, record, sounds: [] });
    assert.equal(proposal.starts["p2.0"], undefined);
    assert.equal(proposal.kept, 1);
    // Applied over a record the author has since timed further, it still leaves theirs.
    const later: ChapterTimingRecord = { timing: { ...record.timing, "p6.0": author("p6.0", { start: 0.1 }) } };
    const applied = applyTimingProposal(later, { ...proposal, starts: { ...proposal.starts, "p2.0": { start: -0.6, why: "cuts in" } } }, BLOCKS, AT);
    assert.equal(applied.timing!["p2.0"]!.start, 0.2);
    assert.equal(applied.timing!["p6.0"]!.start, 0.1);
    assert.equal(applied.timing!["p7.0"]!.by, "arke");
  });

  it("leaves a start the reader holds", () => {
    const proposal = proposeTiming({ blocks: BLOCKS, paragraphs: PARAGRAPHS, record: null, sounds: [], locked: new Set(["p2.0"]) });
    assert.equal(proposal.starts["p2.0"], undefined);
  });

  it("says what it changes as the card does", () => {
    const proposal = proposeTiming({ blocks: BLOCKS, paragraphs: PARAGRAPHS, record: null, sounds: SOUNDS });
    assert.deepEqual(proposalCounts(proposal), { changes: 6, overlaps: 1, reactions: 1, pauses: 3, beds: 1, kept: 0 });
  });

  it("adds its reactions and beds under fresh keys, by Arke", () => {
    const proposal = proposeTiming({ blocks: BLOCKS, paragraphs: PARAGRAPHS, record: null, sounds: SOUNDS });
    const applied = applyTimingProposal<ChapterTimingRecord>({ reactions: { x1: { host: { key: "p4.0", textHash: "h" }, speaker: "ade", words: "mm", offset: 0, by: "author" as const, at: AT } } }, proposal, BLOCKS, AT);
    assert.deepEqual(Object.keys(applied.reactions!), ["x1", "x2"]);
    assert.equal(applied.reactions!["x2"]!.by, "arke");
    assert.equal(applied.beds!["b1"]!.by, "arke");
  });
});
