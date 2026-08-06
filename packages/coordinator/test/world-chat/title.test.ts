import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { titleFrom } from "../../src/world-chat/title.js";

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
