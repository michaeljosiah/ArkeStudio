import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withoutSubject } from "../src/components/conversation.js";

/**
 * A dock says its subject before every line for the thread (turn 126's subjectPrefix), and the
 * master draws the line bare (126b `Draft the rest.`, 128b `Tighten this.`). Shown whole, four
 * presses of one prompt read `About chapter 02: Draft the rest` four times (installed app,
 * 2026-10-05). The thread is the production's own, so only the dock's own subject comes off.
 */

describe("an author's line in a dock is drawn without the subject the dock said for it", () => {
  it("drops the chapter's prefix in that chapter's dock", () => {
    assert.equal(withoutSubject("About chapter 02: Draft the rest", "chapter 02"), "Draft the rest");
  });

  it("drops a passage's prefix and its quote, with or without a paragraph", () => {
    assert.equal(withoutSubject("About this passage in chapter 02, paragraph 4: «Not the scrape of a mistake caught.» Tighten this", "chapter 02"), "Tighten this");
    assert.equal(withoutSubject("About this passage in chapter 02: «a quote\nacross lines» Say it plainer", "chapter 02"), "Say it plainer");
  });

  it("drops a shot's prefix in that shot's dock", () => {
    assert.equal(withoutSubject("About shot 12: What does shot 12 need?", "shot 12"), "What does shot 12 need?");
  });

  it("keeps a line about another chapter or shot whole, since the thread is shared", () => {
    assert.equal(withoutSubject("About chapter 03: Draft the rest", "chapter 02"), "About chapter 03: Draft the rest");
    assert.equal(withoutSubject("About this passage in chapter 03, paragraph 1: «x y z» Tighten this", "chapter 02"), "About this passage in chapter 03, paragraph 1: «x y z» Tighten this");
    assert.equal(withoutSubject("About shot 1: Tighten shot 1", "shot 12"), "About shot 1: Tighten shot 1");
    assert.equal(withoutSubject("About chapter 020: x", "chapter 02"), "About chapter 020: x");
  });

  it("keeps a line that is only a prefix, or that the author typed without one", () => {
    assert.equal(withoutSubject("About chapter 02:", "chapter 02"), "About chapter 02:");
    assert.equal(withoutSubject("Is Ife too cold in this scene?", "chapter 02"), "Is Ife too cold in this scene?");
  });
});
