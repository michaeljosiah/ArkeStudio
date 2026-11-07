import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChapterWordCounts } from "../src/components/chapter-word-counts.js";

it("reports exact before, proposed, delta and batch totals with acceptance copy", () => {
  const html = renderToStaticMarkup(<ChapterWordCounts batch changes={[{ title: "River", before: 2500, after: 3946 }, { title: "Bell", before: 2000, after: 4500 }]} />);
  assert.match(html, /Proposed batch words/);
  assert.match(html, /2,500 → 3,946 \(\+1,446\)/);
  assert.match(html, /4,500 → 8,446 \(\+3,946\)/);
  assert.match(html, /Accepted chapter totals change only after acceptance/);
  assert.equal(renderToStaticMarkup(<ChapterWordCounts changes={[]} />), "");
  assert.equal(renderToStaticMarkup(<ChapterWordCounts changes={[{ title: "River", before: 0, after: 0 }]} />), "", "a plan has no words yet");
});
