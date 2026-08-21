import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conversationTitle } from "../src/components/conversation.js";

/**
 * The first thing said in a production thread (design turn 95).
 *
 * Found by driving the installed app: typing a season brief into Production Chat cleared the
 * composer and did nothing else. No conversation, no error, nothing on disk. Two defects sat on
 * top of each other, and each hid the other.
 *
 * One: the create frame caps `title` at 200 characters, and a frame that fails its schema is
 * dropped without a word — so any opening longer than about two sentences vanished on the wire.
 *
 * Two: creating a conversation does not take a turn. The screen created one with the message as
 * its title and returned, so even a short opening became a label the studio never answered —
 * one `conversation.created` event and nothing after it, where World Chat has the turn.
 */

describe("a conversation's title is derived, never the whole message", () => {
  it("keeps a short opening exactly as it was said", () => {
    assert.equal(conversationTitle("A night porter signs for deliveries nobody sent."),
      "A night porter signs for deliveries nobody sent.");
  });

  it("fits the 200 the wire allows, whatever was typed", () => {
    // The real message that vanished: 245 characters, one ordinary paragraph.
    const said =
      "A night porter at a shuttered railway hotel keeps signing for deliveries nobody sent. " +
      "Five episodes. It answers whether she is being tested or replaced, and it ends with her " +
      "signing for a parcel with her own name on it and taking the job anyway.";
    assert.ok(said.length > 200, "the message this was found with is over the cap");
    const title = conversationTitle(said);
    assert.ok(title.length <= 200, `title is ${title.length} characters`);
    assert.ok(said.startsWith(title.replace(/\u2026$/, "")), "and it is the opening of what was said");
  });

  it("breaks at a word, so the label reads as clipped rather than severed", () => {
    const title = conversationTitle("word ".repeat(80));
    assert.doesNotMatch(title, /wo\u2026$/, "not mid-word");
    assert.match(title, /\u2026$/, "and says it was clipped");
  });

  it("flattens the newlines a pasted brief arrives with", () => {
    assert.equal(conversationTitle("Two lines.\n\n  And a second."), "Two lines. And a second.");
  });

  it("never returns an empty title, which the wire also refuses", () => {
    // min(1) on the same field: a title of "" is dropped exactly as silently as one of 201.
    assert.ok(conversationTitle("x").length >= 1);
  });
});
