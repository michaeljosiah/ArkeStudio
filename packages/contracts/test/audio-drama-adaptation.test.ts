import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { affectedBlocks, changedParagraphs, remapParagraphs, type EpisodeScriptBlock } from "../src/audio-drama.js";
import { ulid } from "../src/ids.js";

/** Changed source (SPEC-057 R-64, R-65): which paragraphs of the adapted version are gone now. */
describe("changed paragraphs", () => {
  const v14 = ["Odile poured.", "“Your brother hated that tower,” Odile said.", "“Then why did he go in?”", "Odile took a long time to answer."];

  it("marks a rewritten paragraph by its number in the adapted version", () => {
    const v15 = [v14[0]!, "“Your brother loved that tower,” Odile said.", v14[2]!, v14[3]!];
    assert.deepEqual(changedParagraphs(v14, v15), [2]);
  });

  it("marks both halves of a split and both parts of a join, and nothing for a move or a repeat", () => {
    const split = [v14[0]!, "“Your brother hated that tower.”", "Odile said.", v14[2]!, v14[3]!];
    assert.deepEqual(changedParagraphs(v14, split), [2], "the split paragraph is gone as it was");
    const joined = [v14[0]!, `${v14[1]} ${v14[2]}`, v14[3]!];
    assert.deepEqual(changedParagraphs(v14, joined), [2, 3]);
    const moved = [v14[3]!, v14[0]!, v14[1]!, v14[2]!];
    assert.deepEqual(changedParagraphs(v14, moved), [], "a move changes no words");
    const repeated = [...v14, v14[0]!];
    assert.deepEqual(changedParagraphs(v14, repeated), [], "a repeat changes no adapted paragraph");
    assert.deepEqual(changedParagraphs([...v14, v14[0]!], v14), [], "a repeated paragraph still found is unchanged");
  });

  it("finds the lines resting on changed paragraphs, by their own pins or the scene's", () => {
    const pinned: EpisodeScriptBlock = { id: ulid(), kind: "dialogue", speaker: "odile", words: "Your brother hated that tower.", paragraphs: [2] };
    const other: EpisodeScriptBlock = { id: ulid(), kind: "dialogue", speaker: "maren", words: "Then why?", paragraphs: [3] };
    const unpinned: EpisodeScriptBlock = { id: ulid(), kind: "narration", words: "She poured." };
    assert.deepEqual(affectedBlocks([pinned, other, unpinned], [1, 2, 3], [2]), [pinned.id, unpinned.id]);
    assert.deepEqual(affectedBlocks([pinned, other, unpinned], [3], [4]), []);
  });
});

describe("codex round 1 on PR 1878", () => {
  it("renumbers paragraphs that moved, and lets a changed one go", () => {
    const v14 = ["A.", "B.", "C."];
    const v15 = ["New.", "A.", "C.", "B, rewritten."];
    assert.deepEqual([...remapParagraphs(v14, v15)], [[1, 2], [3, 3]]);
  });

  it("counts a cue resting on a changed paragraph", () => {
    const cue: EpisodeScriptBlock = { id: ulid(), kind: "sound", heard: "The bell.", paragraphs: [2] };
    assert.deepEqual(affectedBlocks([cue], [], [2]), [cue.id]);
  });
});
