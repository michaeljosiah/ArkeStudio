import assert from "node:assert/strict";
import { it } from "node:test";
import { audiobookWording, audiobookWordsCounts, type AudiobookWordsRow } from "../src/audiobook-words.js";

it("separates case, dialogue punctuation, separators and split compounds without rewriting evidence", () => {
  for (const [authored, heard] of [
    ["Mira left.", "mira left"], ["Mira’s lantern · dawn.", "mira's lantern dawn"],
    ['“Wait,” she said.', "wait she said"], ["'Come home.'", "come home"],
    ["The well-lit door.", "the well lit door"], ["The sailors’ coats.", "the sailors coats"],
  ]) assert.equal(audiobookWording(authored!, heard!), "formatting", authored);
  assert.equal(audiobookWording("Hello  world", "Hello\nworld"), "match");
  assert.equal(audiobookWording("Ｈｅｌｌｏ", "Hello"), "match");
});

it("retains every deliberately changed meaning and uncertain recognition in the review set", () => {
  for (const [authored, heard] of [
    ["Do not enter.", "Do enter."], ["Pay 15 coins.", "Pay 50 coins."], ["1.5 metres", "15 metres"],
    ["-3 degrees", "3 degrees"], ["5%", "5"], ["1/2", "1 2"], ["10:30", "10 30"],
    ["She ran home.", "She ran ran home."], ["She ran home before dark.", "She ran home."],
    ["She ran home.", "The neighbour left."], ["She ran home.", "whisper She ran home."],
    ["We live in the US.", "we live in the us"], ["We'll leave.", "well leave"],
    ["The colour changed.", "The color changed."], ["She paid 12.", "she paid twelve"],
    ["Dr Finch left.", "Doctor Finch left."], ["Maren left.", "Mary left."], ["Their gate.", "There gate."],
  ]) assert.equal(audiobookWording(authored!, heard!), "review", `${authored} / ${heard}`);
});

it("reduces formatting review rows while retaining the raw mismatch and all substantive differences", () => {
  const row: AudiobookWordsRow = { chapterId: "chapter", chapterTitle: "Chapter", key: "p0.0", label: "Block 1", text: "Mira left.",
    comparison: { status: "compared", audioHash: `sha256:${"a".repeat(64)}`, targetTextHash: `sha256:${"b".repeat(64)}`, transcriber: { id: "fixture", version: "1", normalizationVersion: 1 },
      observedText: "mira left", result: "mismatch", differences: [{ kind: "changed", authored: "Mira left.", observed: "mira left" }], boundaryAlignment: "unavailable" } };
  const before = structuredClone(row);
  assert.deepEqual(audiobookWordsCounts([row]), { compared: 1, match: 1, differ: 0, unavailable: 0, unchecked: 0 });
  assert.deepEqual(row, before);
  assert.deepEqual(audiobookWordsCounts([{ ...row, text: "Mira did not leave." }]), { compared: 1, match: 0, differ: 1, unavailable: 0, unchecked: 0 });
});
