import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { BeforeShotCheck } from "@arke-studio/contracts";
import { BeforeShotChecks } from "../src/components/before-shot-checks.js";

/** A shot's checks before it is made, on the Generate bench (design turn 288b). */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; dom.document.body.innerHTML = ""; });

const ITEMS: BeforeShotCheck[] = [
  { id: "line", result: "pass", says: "word for word" },
  { id: "camera", result: "fix", says: "says locked off" },
  { id: "light", result: "fix", says: "none named" },
  { id: "board", result: "fix", says: "with 12–14 · 9.5 s" },
];

async function mount(items: BeforeShotCheck[], handlers: { onFix?: (item: BeforeShotCheck) => void; onBoard?: () => void; onAnyway?: () => void } = {}) {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<BeforeShotChecks items={items} onFix={handlers.onFix} onBoard={handlers.onBoard} onAnyway={handlers.onAnyway ?? (() => {})} />));
  return container;
}
const press = async (container: HTMLElement, text: string, index = 0) => {
  const button = [...container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text)[index];
  assert.ok(button, `${text} is present`);
  await act(async () => button.dispatchEvent(new dom.Event("click", { bubbles: true })));
};

describe("the shot's checks before it is made", () => {
  it("counts what passed beside the press and opens the list, labels and figures only", async () => {
    const container = await mount(ITEMS, { onFix: () => {}, onBoard: () => {} });
    assert.equal(container.querySelector(".fy-takechecks__count")!.textContent, "Checks · 1 of 4");
    await press(container, "Checks · 1 of 4");
    const rows = [...container.querySelectorAll(".fy-takechecks__row")].map((row) => [row.querySelector(".fy-takechecks__label")!.textContent, row.querySelector(".fy-takechecks__result")!.textContent]);
    assert.deepEqual(rows, [["Line", "word for word"], ["Camera", "says locked off"], ["Light", "none named"], ["Board", "with 12–14 · 9.5 s"]]);
    assert.equal(container.querySelector(".fy-takechecks__panel small, .fy-takechecks__panel p"), null, "no caption");
  });

  it("hands a row to fix to Arke, the board to its own press, and passes over the hard ones on request", async () => {
    const fixed: string[] = []; let boards = 0, anyway = 0;
    const container = await mount(ITEMS, { onFix: (item) => fixed.push(item.id), onBoard: () => { boards++; }, onAnyway: () => { anyway++; } });
    await press(container, "Checks · 1 of 4");
    await press(container, "Fix", 0);
    assert.deepEqual(fixed, ["camera"]);
    await press(container, "Checks · 1 of 4");
    await press(container, "Make the board");
    assert.equal(boards, 1);
    await press(container, "Checks · 1 of 4");
    await press(container, "Open anyway");
    assert.equal(anyway, 1, "camera is hard, so the press can be passed over");
  });

  it("offers no way past when nothing hard is left, and nothing at all with no items", async () => {
    const container = await mount([{ id: "light", result: "fix", says: "none named" }], { onFix: () => {} });
    await press(container, "Checks · 0 of 1");
    assert.equal([...container.querySelectorAll("button")].some((b) => b.textContent === "Open anyway"), false);
    await act(async () => root!.unmount()); root = null;
    assert.equal((await mount([])).innerHTML, "");
  });
});
