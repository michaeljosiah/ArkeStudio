import assert from "node:assert/strict";
import { it } from "node:test";
import { nextPollDelay } from "../../src/queue/dispatcher.js";

/** A long job polled at 1.5 s for its whole life made a provider call per poll (issue 2782). */
it("polls at the base for 20 s after news, then half as long again each poll, up to 10 s", () => {
  assert.equal(nextPollDelay(1_500, 1_500, 0), 1_500);
  assert.equal(nextPollDelay(1_500, 1_500, 19_999), 1_500, "the first 20 s stay quick");
  assert.equal(nextPollDelay(1_500, 1_500, 20_000), 2_250);
  assert.equal(nextPollDelay(1_500, 9_000, 60_000), 10_000, "capped");
  assert.equal(nextPollDelay(1_500, 10_000, 0), 1_500, "news resets it");
  assert.equal(nextPollDelay(15_000, 15_000, 60_000), 15_000, "a base above the cap is kept");
  assert.equal(nextPollDelay(5, 30, 60_000), 35, "a small base stays small: at most seven bases");

  // A five-minute job that reports nothing new: was 200 polls.
  let at = 0, delay = 1_500, polls = 0;
  while (at < 300_000) { polls++; delay = nextPollDelay(1_500, delay, at); at += delay; }
  assert.equal(polls, 45);
});
