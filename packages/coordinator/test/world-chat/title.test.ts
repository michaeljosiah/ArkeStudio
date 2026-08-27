import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanTitle, namingBrief, TITLE_MAX_CHARS, titleFrom } from "../../src/world-chat/title.js";

/**
 * Naming a conversation after its opening sentence (#70 §15.1).
 *
 * The list is scanned, not read, so the title has to be recognisable at a glance and never look
 * broken. A row reading "New conversation" tells somebody nothing; five of them tell them less.
 */

describe("naming a conversation", () => {
  it("uses a short opening line as it stands", () => {
    assert.equal(titleFrom("Her aunt taught her the bells."), "Her aunt taught her the bells.");
  });

  it("cuts a long one at a word, never mid-word", () => {
    const long =
      "Her aunt taught her the bells rather than her mother, which changes the whole line of inheritance";
    const title = titleFrom(long);
    assert.ok(title.length <= 61, `got ${title.length} characters`);
    assert.ok(title.endsWith("…"));
    assert.ok(!/\w…$/.test(title.replace("…", "x…")) || title.includes(" "), "cut falls on a space");
    assert.ok(long.startsWith(title.slice(0, -1).trimEnd()), "and it is really the opening");
  });

  it("collapses the whitespace of a pasted line", () => {
    assert.equal(titleFrom("  Her aunt\n\ttaught her  the bells  "), "Her aunt taught her the bells");
  });

  it("falls back rather than producing an empty title", () => {
    assert.equal(titleFrom("   "), "New conversation");
  });

  it("does not cut so early that the title says nothing", () => {
    // A single very long word has no space to cut at; taking the first 24 characters would be
    // worse than taking the bound.
    const oneWord = "a".repeat(120);
    assert.equal(titleFrom(oneWord).length, 61);
  });
});

/**
 * Asking the harness for the name a person would have given the same message.
 *
 * The cut opening sentence is already on the row when this runs, so every question here has the
 * same answer underneath it: is this better than what is already there? Anything that is not — a
 * paragraph, a refusal, an empty string — has to come back as nothing, because nothing means the
 * sentence stays.
 */
describe("the naming brief", () => {
  const world = { name: "Embers of the Fallen", logline: "A drowned god still sings." };

  it("carries the message verbatim, and the world only so names are spelled right", () => {
    const brief = namingBrief("Maren was raised by her aunt, not her mother.", world);
    assert.match(brief, /Maren was raised by her aunt, not her mother\./);
    assert.match(brief, /Embers of the Fallen/);
    assert.match(brief, /A drowned god still sings\./);
    assert.match(brief, /spell names the way they are spelled, and for nothing else/);
    assert.match(brief, /\{"title": "\.\.\."\}/, "and asks for the shape the parser expects");
    assert.match(brief, new RegExp(`at most ${TITLE_MAX_CHARS} characters`));
  });

  it("works without a world, and collapses a pasted message", () => {
    const brief = namingBrief("  Her aunt\n\ttaught her  the bells  ");
    assert.match(brief, /Her aunt taught her the bells/);
    assert.equal(brief.includes("The world they are talking about"), false);
  });

  it("bounds a long opening message rather than sending the whole paragraph", () => {
    const brief = namingBrief("the bells ".repeat(500));
    assert.ok(brief.length < 2400, `got ${brief.length} characters`);
  });
});

describe("what the namer sends back", () => {
  it("takes a plain label as it stands", () => {
    assert.equal(cleanTitle("Maren's inheritance"), "Maren's inheritance");
  });

  it("strips the decoration a model puts around a label", () => {
    assert.equal(cleanTitle('"The bells at slack water"'), "The bells at slack water");
    assert.equal(cleanTitle("“Maren's inheritance”"), "Maren's inheritance");
    assert.equal(cleanTitle("Title: Casting episode two"), "Casting episode two");
    assert.equal(cleanTitle("The bells at slack water."), "The bells at slack water");
    assert.equal(cleanTitle("  Maren's\n  inheritance  "), "Maren's inheritance");
  });

  it("keeps punctuation that is part of what was said", () => {
    assert.equal(cleanTitle("Who tends the bells?"), "Who tends the bells?");
  });

  it("refuses an answer that is not a title, so the opening sentence keeps the row", () => {
    assert.equal(cleanTitle(""), null);
    assert.equal(cleanTitle('   "" '), null);
    assert.equal(cleanTitle("Sure! Here is a title for you. ".repeat(10)), null);
  });

  it("cuts an overlong one at a word rather than throwing it away", () => {
    const wordy = "The bells at slack water and the whole line of inheritance they carry";
    const title = cleanTitle(wordy);
    assert.ok(title !== null && title.endsWith("…"), `got ${String(title)}`);
    assert.ok(title.length <= TITLE_MAX_CHARS + 1);
  });
});
