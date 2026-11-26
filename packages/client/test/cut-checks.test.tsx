import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { CutCheck } from "@arke-studio/contracts";
import { CutChecks } from "../src/components/cut-checks.js";

/** A cut's checks beside Export film (design turn 288d). */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; dom.document.body.innerHTML = ""; });

const ITEMS: CutCheck[] = [
  { id: "lines", result: "fix", says: "shot 2's under shot 3", clipIds: ["cl_l2", "cl_l5"] },
  { id: "room", result: "fix", says: "gap at 0:05 · 1.5 s" },
  { id: "set-ups", result: "pass", says: "none twice running" },
];

async function mount(items: CutCheck[], onShow?: (clipId: string) => void) {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<CutChecks items={items} onShow={onShow} />));
  return container;
}
const press = async (container: HTMLElement, text: string) => {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  assert.ok(button, `${text} is present`);
  await act(async () => button.dispatchEvent(new dom.Event("click", { bubbles: true })));
};

describe("the cut's checks beside Export", () => {
  it("counts what passed and opens the list under it, labels and figures only", async () => {
    const container = await mount(ITEMS, () => {});
    const count = container.querySelector(".fy-takechecks__count")!;
    assert.equal(count.textContent, "Checks · 1 of 3");
    assert.ok(count.querySelector(".fy-dot--warn"), "something to fix");
    await press(container, "Checks · 1 of 3");
    assert.equal(container.querySelector(".fy-cutchecks__panel")!.getAttribute("aria-label"), "On the cut");
    const rows = [...container.querySelectorAll(".fy-takechecks__row")].map((row) => [row.querySelector(".fy-takechecks__label")!.textContent, row.querySelector(".fy-takechecks__result")!.textContent, row.getAttribute("data-result")]);
    assert.deepEqual(rows, [["Lines", "shot 2's under shot 3", "fix"], ["Room tone", "gap at 0:05 · 1.5 s", "fix"], ["Set-ups", "none twice running", "pass"]]);
    assert.equal(container.querySelector(".fy-takechecks__panel small, .fy-takechecks__panel p"), null, "no caption");
  });

  it("shows the first clip a fix is about, and offers nothing where a fix names none", async () => {
    const shown: string[] = [];
    const container = await mount(ITEMS, (clipId) => shown.push(clipId));
    await press(container, "Checks · 1 of 3");
    assert.equal([...container.querySelectorAll("button")].filter((b) => b.textContent === "Show").length, 1, "the gap names no clip");
    await press(container, "Show");
    assert.deepEqual(shown, ["cl_l2"]);
    assert.equal(container.querySelector(".fy-takechecks__panel"), null, "the list closes on the way to the clip");
  });

  it("is green when everything passes, and is not there at all with nothing to read", async () => {
    const container = await mount([{ id: "room", result: "pass", says: "no gap, none repeated" }]);
    assert.ok(container.querySelector(".fy-takechecks__count .fy-dot--ok"));
    await act(async () => root!.unmount()); root = null;
    assert.equal((await mount([])).innerHTML, "");
  });
});
