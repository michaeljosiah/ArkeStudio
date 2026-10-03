import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { audiobookBlockOptions, audiobookBlocks, audiobookNoteFor, DEFAULT_AUDIOBOOK_BOOK } from "../src/index.js";

/**
 * One voice, one block (design turn 190): Na Love or Juju chapter 01 was 121 paragraphs cut into 169
 * blocks, every one read by the same voice, so a line and its tag were two takes with a pause
 * inside a sentence. Under one reader a paragraph is one block, and the speakers are rows in it.
 */
const LINE = "\"It is not possible,\"";
const REPLY = "\"The goat was in the boot.\"";
const BODY = `${LINE} Ade said. ${REPLY}\n\nTunde laughed until his chest hurt.\n\n* * *\n\nBelow them the quarter opened.`;
const CAST = {
  lines: [
    { speaker: "Ade", sheet: "ade", paragraph: 0, occurrence: 0, quote: LINE },
    { speaker: "Tunde", sheet: "tunde", paragraph: 0, occurrence: 0, quote: REPLY },
  ],
};

describe("audiobookBlocks, one reader one block", () => {
  it("cuts a paragraph at its lines when nothing merges, as the cast reading does", () => {
    const { blocks } = audiobookBlocks(BODY, CAST, "Chapter 1");
    assert.deepEqual(blocks.map((block) => block.key), ["title", "p0.0", "p0.1", "p0.2", "p1.0", "p3.0"]);
    assert.equal(blocks.some((block) => block.rows !== undefined), false);
  });

  it("makes a paragraph one block under one reader, its speakers kept as rows and its words the paragraph's own", () => {
    const { blocks } = audiobookBlocks(BODY, CAST, "Chapter 1", { merge: true });
    assert.deepEqual(blocks.map((block) => block.key), ["title", "p0.0", "p1.0", "p3.0"]);
    const merged = blocks[1]!;
    assert.equal(merged.text, `${LINE} Ade said. ${REPLY}`, "the exact paragraph, so a pin finds its words");
    assert.equal(merged.speaker, undefined, "a block with rows has no speaker of its own");
    assert.deepEqual(merged.rows?.map((row) => [row.speaker ?? "narration", row.text]), [["Ade", LINE], ["narration", "Ade said."], ["Tunde", REPLY]]);
    assert.equal(blocks[2]!.rows, undefined, "a paragraph of one turn is a block as it was");
    assert.equal(blocks[2]!.text, "Tunde laughed until his chest hurt.");
  });

  it("keeps a scene break out of every block", () => {
    const { blocks } = audiobookBlocks(BODY, CAST, "Chapter 1", { merge: true });
    assert.equal(blocks.some((block) => block.text === "* * *"), false);
  });

  it("reads a speaker a person records apart, and splits its neighbours around it", () => {
    const { blocks } = audiobookBlocks(BODY, CAST, "Chapter 1", { merge: true, apart: (turn) => turn.sheet === "tunde" });
    assert.deepEqual(blocks.map((block) => block.key), ["title", "p0.0", "p0.1", "p1.0", "p3.0"]);
    assert.deepEqual(blocks[1]!.rows?.map((row) => row.speaker ?? "narration"), ["Ade", "narration"]);
    assert.equal(blocks[2]!.speaker, "Tunde");
    assert.equal(blocks[2]!.rows, undefined);
    assert.equal(blocks[1]!.text, `${LINE} Ade said.`, "joined, since the run is not the whole paragraph");
  });

  it("is no block at all for a chapter of scene breaks, merged or not", () => {
    assert.deepEqual(audiobookBlocks("* * *", null, "Chapter 1", { merge: true }).blocks, []);
  });
});

describe("audiobookBlockOptions", () => {
  it("merges under narrator and performed, never under cast", () => {
    assert.equal(audiobookBlockOptions(null).merge, true, "the default reading is the narrator's");
    assert.equal(audiobookBlockOptions({ reading: "performed" }).merge, true);
    assert.equal(audiobookBlockOptions({ reading: "narrator" }).merge, true);
    assert.equal(audiobookBlockOptions({ reading: "cast" }).merge, false);
    assert.equal(DEFAULT_AUDIOBOOK_BOOK.reading, "narrator");
  });

  it("reads a recorded speaker apart whatever the reading", () => {
    const options = audiobookBlockOptions({ reading: "performed", recorded: ["tunde"] });
    assert.equal(options.apart?.({ paragraph: 0, text: REPLY, speaker: "Tunde", sheet: "tunde" }), true);
    assert.equal(options.apart?.({ paragraph: 0, text: LINE, speaker: "Ade", sheet: "ade" }), false);
    assert.equal(audiobookBlockOptions({ reading: "performed" }).apart, undefined);
  });
});

describe("audiobookNoteFor over the turns a block holds", () => {
  const rows = [{ text: LINE, speaker: "Ade", sheet: "ade" }, { text: "Ade said." }, { text: REPLY, speaker: "Tunde", sheet: "tunde" }];
  const block = { rows };

  it("plays a lone noted speaker's note as it stands", () => {
    assert.equal(audiobookNoteFor({ reading: "performed", notes: { ade: "protesting through a smile" } }, block), "protesting through a smile");
  });

  it("names each speaker when several carry a note", () => {
    assert.equal(audiobookNoteFor({ reading: "performed", notes: { ade: "protesting", tunde: "deadpan" } }, block), "Ade: protesting Tunde: deadpan");
  });

  it("plays no note under any other reading, or where no speaker has one", () => {
    assert.equal(audiobookNoteFor({ reading: "narrator", notes: { ade: "x" } }, block), undefined);
    assert.equal(audiobookNoteFor({ reading: "performed", notes: {} }, block), undefined);
  });

  it("leaves a single-turn block as it was", () => {
    assert.equal(audiobookNoteFor({ reading: "performed", notes: { ade: "x" } }, { speaker: "Ade", sheet: "ade" }), "x");
    assert.equal(audiobookNoteFor({ reading: "performed", notes: { ade: "x" } }, {}), undefined);
  });
});
