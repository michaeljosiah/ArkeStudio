import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ComicAskCards, ComicPlanCard, comicPilotAsk } from "../src/components/comic-plan-card.js";

/** A graphic novel's setup (design turn 249b): the question's cards, and the one plan. */
describe("graphic novel setup (turn 249b)", () => {
  it("draws the question Arke asks as cards, each its own answer", () => {
    const reading = renderToStaticMarkup(<ComicAskCards ask="reading" disabled={false} onChoose={() => {}} />);
    assert.match(reading, /Left to right.*Right to left.*Scroll/s);
    assert.match(reading, /as manga/);
    const pilot = renderToStaticMarkup(<ComicAskCards ask="pilot" disabled={false} onChoose={() => {}} />);
    assert.match(pilot, />Yes<.*>No</s);
  });

  it("shows the plan's style by its page, its facts, and a row for each chapter with the source's words", () => {
    const html = renderToStaticMarkup(<ComicPlanCard sourceTitle="Low Water" sourceWords={(from) => from === 1 ? 5840 : undefined}
      plan={{ reading: "ltr", aspect: "2:3", pilot: true, style: { words: "Manga.", preset: "manga" }, chapters: [
        { from: 1, title: "The tide", pages: 8, layout: "feature" }, { from: 2, title: "Salt", pages: 7 },
      ] }} />);
    assert.match(html, /Graphic novel · from Low Water · 2 chapters · ~15 pages/);
    assert.match(html, /src="\.\/comic-styles\/manga\.jpg"/);
    assert.match(html, /Left to right/);
    assert.match(html, /Pilot · chapter 1/);
    assert.match(html, /The tide<small>Chapter 1 · 5,840 words<\/small>/);
    assert.match(html, /~8 pages/);
    assert.match(html, /Feature/);
    assert.match(html, /Page counts are a first guess/);
  });

  it("asks for the pilot chapter's pages", () => {
    assert.equal(comicPilotAsk("The tide"), "Draft the pilot: turn chapter 1, The tide, into pages.");
  });
});
