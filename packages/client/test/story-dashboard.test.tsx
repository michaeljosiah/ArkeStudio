import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { storyProgressDay } from "@arke-studio/contracts";
import { ChapterTreeScreen, ProductionChatScreen, ProductionDashboardScreen } from "../src/screens/production.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("shows a six-chapter book's total and accepted context without repeating the in-hand chapter (issue 1002)", () => {
  const state = structuredClone(FIXTURE_STATE);
  const production = state.world!.productions[0]!;
  production.meta.format = "story";
  production.story = { version: 2, targetLength: "6 chapters at 3,000 words each" };
  production.chapters = Array.from({ length: 6 }, (_, i) => ({
    id: `chapter-${i + 1}`, file: `chapter-${i + 1}`, order: i + 1, title: `Chapter ${i + 1}`, status: "planned", version: 1,
  }));
  __setStateForTest(state);
  const render = (screen: React.ReactNode) => renderToString(
    <MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/${production.meta.id}`]}>
      <Routes><Route path="/w/:worldId/p/:prodId" element={screen} /></Routes>
    </MemoryRouter>,
  ).replace(/<!-- -->/g, "");
  try {
    const dashboard = render(<ProductionDashboardScreen />);
    assert.match(dashboard, /0 \/ 18,000 words in the book/);
    assert.equal(dashboard.match(/Chapter 1</g)?.length, 1, "the in-hand card is not repeated as a row");
    assert.match(render(<ChapterTreeScreen />), /6 chapters · 0 drafted · 0 of 18,000 words/);
    const develop = render(<ProductionChatScreen />);
    assert.match(develop, /all 6 chapters/);
    assert.match(develop, /Accepted work is in Overview and Chapters/);
    assert.doesNotMatch(develop, /season question|each episode|all 0 scenes|nothing yet|Nothing decided yet/);
  } finally {
    __setStateForTest(FIXTURE_STATE);
  }
});

it("shows the plan and daily count, updates from a snapshot, and opens the chapter", async () => {
  const dom = parseHTML("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const state = structuredClone(FIXTURE_STATE);
  const production = state.world!.productions[0]!;
  production.meta.format = "story";
  production.story = { version: 3, targetLength: "80k words" };
  production.chapters = [
    { id: "retired", file: "retired", order: 1, title: "Retired chapter", status: "planned", version: 1, retired: true },
    { id: "next", file: "next", order: 2, title: "The next night", status: "drafted", version: 1, words: 10, synopsis: "Maren opens the ledger.", when: "Second watch", draftedAgainst: 2 },
  ];
  const day = storyProgressDay(new Date());
  production.progress = { days: { [day]: 42 } };
  __setStateForTest(state);
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/${production.meta.id}`]}>
      <Routes>
        <Route path="/w/:worldId/p/:prodId" element={<ProductionDashboardScreen />} />
        <Route path="/w/:worldId/p/:prodId/story/chapters/next" element={<p>Chapter workspace opened</p>} />
      </Routes>
    </MemoryRouter>));
    assert.match(container.textContent!, /42 words today/);
    assert.match(container.textContent!, /80,000/);
    assert.match(container.textContent!, /Maren opens the ledger/);
    assert.match(container.textContent!, /overview moved · v2 → v3/);
    assert.doesNotMatch(container.textContent!, /Retired chapter/);
    const updated = structuredClone(state);
    updated.world!.productions[0]!.progress = { days: { [day]: 50 } };
    await act(async () => __setStateForTest(updated));
    assert.match(container.textContent!, /50 words today/);
    const button = [...container.querySelectorAll("button")].find((button) => button.textContent === "Continue chapter")!;
    await act(async () => button.click());
    assert.match(container.textContent!, /Chapter workspace opened/);
  } finally {
    await act(async () => root.unmount());
    __setStateForTest(FIXTURE_STATE);
  }
});
