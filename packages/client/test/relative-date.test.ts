import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { relativeDate, shortDate } from "../src/lib/format.js";

/**
 * The world card's age band (design 1a, issue 1007).
 *
 * The card writes `4d ago` rather than `Sep 7, 02:22` because the front door's question is which
 * of these did I touch last, and because the band it shares with the world's counts is 280px
 * wide: the long form took the room the counts needed and truncated them at every window width.
 *
 * `now` is the value that made the picker's staleness visible (codex, 2026-09-09) — a card drawn
 * as `now` went on saying `now` for as long as the screen was open, because nothing re-rendered
 * it. The screen ticks every minute, and these are the steps that tick has to keep honest.
 */

const AT = new Date("2026-09-09T12:00:00.000Z");
const ago = (ms: number): string => relativeDate(new Date(AT.getTime() - ms).toISOString(), AT);

describe("how long ago, in the fewest characters that carry it", () => {
  it("steps from now through minutes and hours to days", () => {
    assert.equal(ago(0), "now");
    assert.equal(ago(59_000), "now", "under a minute is not worth a number");
    assert.equal(ago(60_000), "1m ago");
    assert.equal(ago(59 * 60_000), "59m ago");
    assert.equal(ago(60 * 60_000), "1h ago", "the step the picker's tick has to reach");
    assert.equal(ago(23 * 3_600_000), "23h ago");
    assert.equal(ago(24 * 3_600_000), "1d ago");
    assert.equal(ago(6 * 86_400_000), "6d ago");
  });

  it("gives up on ages past a week and says the date, which is shorter anyway", () => {
    const old = new Date(AT.getTime() - 30 * 86_400_000).toISOString();
    assert.equal(relativeDate(old, AT), shortDate(old));
  });

  it("says nothing it cannot know", () => {
    assert.equal(relativeDate(undefined), "—");
    assert.equal(relativeDate("not a date"), "not a date", "an unparseable stamp is shown as it is");
  });
});
