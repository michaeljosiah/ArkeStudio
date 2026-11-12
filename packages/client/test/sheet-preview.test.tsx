import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.document, { implementation: { createHTMLDocument: () => parseHTML("<!doctype html><html><body></body></html>").document } });
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }) });
Object.assign(globalThis, { document: dom.document, window: dom.window });

function render(kind: "location" | "faction", bodies: Array<{ heading: string; body: string }>) {
  const state = structuredClone(FIXTURE_STATE), source = state.world!.sheets.find(s => s.type === kind)!;
  assert.ok(source);
  source.sections = bodies;
  state.world!.sheets = [source];
  const before = JSON.stringify(source);
  __setStateForTest(state);
  try {
    const html = renderToString(<MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/${kind === "location" ? "locations" : "factions"}`]}><App /></MemoryRouter>);
    assert.equal(JSON.stringify(source), before, "viewing a preview preserves the source record");
    return parseHTML(html).document;
  } finally { __setStateForTest(FIXTURE_STATE); }
}

it("reads formatted location ledes before choosing the existing first sentence", () => {
  const page = render("location", [{ heading: "Look", body: "**Direct manuscript facts.** A *quiet* [room](https://example.com)." }]);
  const preview = page.querySelector(".fy-gridcard__body")!;
  assert.equal(preview.textContent, "Direct manuscript facts.");
  assert.equal(preview.children.length, 0, "plain text does not add interactive links or styled children");
  assert.ok(preview.closest("button"), "the card retains its original navigation control");
});

it("keeps ordinary prose and literal HTML escaped inside the existing card", () => {
  assert.equal(render("location", [{ heading: "Look", body: "A quiet\nroom. A second sentence." }]).querySelector(".fy-gridcard__body")?.textContent, "A quiet room.");
  const page = render("location", [{ heading: "Look", body: '<img src="bad" onerror="alert(1)"> A room.' }]);
  const preview = page.querySelector(".fy-gridcard__body")!;
  assert.equal(preview.textContent, '<img src="bad" onerror="alert(1)"> A room.');
  assert.equal(preview.querySelector("img,[onerror],script,a"), null);
});

it("reuses the same plain preview for faction ledes and wants/fears", () => {
  const page = render("faction", [
    { heading: "Purpose", body: "The **watch** keeps [records][r].\n\n[r]: https://example.com" },
    { heading: "Wants", body: "*Safe* [passage](javascript:alert(1)). Nothing else." },
    { heading: "Fears", body: "**Lost** records. Another sentence." },
  ]);
  assert.equal(page.querySelector(".fy-gridcard__body")?.textContent, "The watch keeps records.");
  assert.deepEqual([...page.querySelectorAll(".fy-wants__line")].map(e => e.textContent), ["wants: Safe passage.", "fears: Lost records."]);
  assert.equal(page.querySelector(".fy-wants a"), null);
});
