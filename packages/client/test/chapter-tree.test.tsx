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
        { ...salt, meta: { ...salt.meta, id: "inkbound", format: "story" as const, title: "Inkbound" }, chapters },
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
  { id: "the-same-ink", file: "02-the-same-ink", order: 1, title: "The same ink", status: "drafted", version: 4, words: 2930 },
  { id: "neap", file: "01-neap", order: 2, title: "Neap", status: "drafted", version: 4, words: 3120 },
  { id: "her-own-hand", file: "04-her-own-hand", order: 3, title: "Her own hand", status: "planned", version: 1 },
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

  it("a chapter without words shows its status instead", () => {
    const html = render(CHAPTERS);
    assert.match(html, /planned/, "the planned chapter says so");
    assert.match(html, /3120 words/, "a drafted chapter shows its words");
  });
});
