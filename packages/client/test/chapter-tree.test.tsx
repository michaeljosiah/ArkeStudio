import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ChapterSummary, ClientState } from "@arke-studio/contracts";
import { ChapterTreeScreen } from "../src/screens/production.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * The chapter tree renders the bundle's resolved order (issue 399): the coordinator sorts by the
 * explicit `order` field and the summary carries the dense sequence, so the rows here must follow
 * the array and label each row with `order` — never with a number reconstructed from position or
 * filename.
 */

function withChapters(chapters: ChapterSummary[]): ClientState {
  const world = FIXTURE_STATE.world!;
  const salt = world.productions.find((p) => p.meta.id === "saltlight")!;
  return {
    ...FIXTURE_STATE,
    world: {
      ...world,
      productions: [
        ...world.productions,
        { ...salt, meta: { ...salt.meta, id: "inkbound", format: "story" as const, title: "Inkbound" }, story: { version: 3 }, chapters },
      ],
    },
  };
}

function render(chapters: ChapterSummary[]): string {
  __setStateForTest(withChapters(chapters));
  return renderToString(
    <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/inkbound/story/chapters`]}>
      <Routes>
        <Route path="/w/:worldId/p/:prodId/story/chapters" element={<ChapterTreeScreen />} />
      </Routes>
    </MemoryRouter>,
  ).replace(/<!-- -->/g, "");
}

const CHAPTERS: ChapterSummary[] = [
  {
    id: "the-same-ink",
    file: "02-the-same-ink",
    order: 1,
    title: "The same ink",
    status: "drafted",
    version: 4,
    words: 2930,
    synopsis: "Odile's hand and the correction's are one hand.",
    pov: "maren-kest",
    when: "Neap · second night",
    draftedAgainst: 2,
  },
  { id: "neap", file: "01-neap", order: 2, title: "Neap", status: "drafted", version: 4, words: 3120, draftedAgainst: 3 },
  { id: "her-own-hand", file: "04-her-own-hand", order: 3, title: "Her own hand", status: "planned", version: 1, synopsis: "Maren writes the seventh bell in." },
];

describe("the chapter tree renders resolved order", () => {
  it("rows follow the bundle array and are labelled with the explicit order", () => {
    const html = render(CHAPTERS);
    const first = html.indexOf("The same ink");
    const second = html.indexOf("Neap");
    const third = html.indexOf("Her own hand");
    assert.ok(first >= 0 && second > first && third > second, "rows appear in bundle order, not filename order");
    assert.match(html, /01/, "the first row is labelled 01");
    assert.ok(!html.includes("NaN"), "no row falls back to a missing legacy field");
    assert.match(html, /3 chapters/, "the header counts every chapter");
  });

  it("is called Chapters, and every row is a destination (turn 126)", () => {
    const html = render(CHAPTERS);
    assert.match(html, /<h1[^>]*>Chapters<\/h1>/, "the screen is titled by the rail's word");
    assert.doesNotMatch(html, /Chapter tree/);
    const rows = html.match(/<button[^>]*class="fy-row[^"]*"/g) ?? [];
    assert.equal(rows.length, 3, "a row is a button that opens the chapter, not a line in a list");
    assert.match(html, /6,050 words/, "the book's count is the sum of the chapters' words");
    assert.match(html, /in hand/, "the first chapter without words is the one in hand");
    assert.match(html, />New chapter</, "New chapter is a press on the door");
  });

  it("is the outline: the plan under the title, and the mark for an overview that moved (turn 127)", () => {
    const html = render(CHAPTERS);
    assert.match(html, /Odile&#x27;s hand and the correction&#x27;s are one hand\./, "a drafted chapter shows its synopsis");
    assert.match(html, /Maren writes the seventh bell in\./, "a planned chapter is its synopsis with no words");
    assert.match(html, /Maren Kest/, "the point of view is shown by name, not by slug");
    assert.match(html, /Neap · second night/);
    assert.equal((html.match(/overview moved/g) ?? []).length, 1, "only the chapter drafted below the overview's version is marked");
    assert.match(html, /2 drafted/, "the meta counts drafted chapters");
  });

  it("a chapter without words shows its status instead", () => {
    const html = render(CHAPTERS);
    assert.match(html, /planned/, "the planned chapter says so");
    assert.match(html, /3,120 words/, "a drafted chapter shows its words, formatted");
  });
});
