import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { FrameActions } from "../src/screens/scene-workspace/frame-actions.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { innerWidth: 1000, innerHeight: 800 });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(dom.HTMLElement.prototype, { getBoundingClientRect: () => ({ top: 40, left: 40, right: 210, bottom: 80, width: 170, height: 100 }) });
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  dom.document.body.replaceChildren();
  delete (dom.window as unknown as { arke?: unknown }).arke;
});

async function mount(overrides: Partial<ComponentProps<typeof FrameActions>> = {}) {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  root = createRoot(container);
  const calls: string[] = [];
  await act(async () => root!.render(<FrameActions
    shotNumber={3} title="The shutter" slug="the-sitting" framePath="artifacts/frame.png" variants={2}
    disabled={false} canUpload canClear
    onPreview={() => calls.push("preview")} onVariants={() => calls.push("variants")}
    onUpload={() => calls.push("upload")} onClear={() => calls.push("clear")}
    readAloud={{ source: { of: "shot", productionId: "sitting", sceneId: "sc_01", shotId: "sh_03" }, title: "Shot 3", text: "The shutter opens." }}
    {...overrides}
  />));
  return { container, calls };
}
async function click(element: Element | null) {
  assert.ok(element);
  await act(async () => (element as HTMLElement).click());
}

it("offers four image icons and saves the same world-relative frame that it previews", async () => {
  const saves: unknown[][] = [];
  (dom.window as unknown as { arke: unknown }).arke = { saveMedia: async (...args: unknown[]) => { saves.push(args); return { ok: true }; } };
  const { container, calls } = await mount();
  const buttons = container.querySelectorAll(".fy-swrow__frameactions > button");
  assert.equal(buttons.length, 4);
  assert.deepEqual([...buttons].map((button) => button.getAttribute("title")), ["Expand image", "Frame variants", "Download Shot 3 - The shutter.png", "More image actions"]);
  await click(buttons[0]!);
  await click(buttons[1]!);
  await click(buttons[2]!);
  assert.deepEqual(calls, ["preview", "variants"]);
  assert.deepEqual(saves, [["the-sitting", "artifacts/frame.png", "Shot 3 - The shutter.png"]]);
  await click(buttons[3]!);
  const menu = dom.document.querySelector('.fy-swimage-menu[role="dialog"]');
  assert.ok(menu);
  assert.equal(menu.parentElement, dom.document.body, "image actions clear the clipping frame");
  await click([...menu.querySelectorAll("button")].find((button) => button.textContent === "Replace frame")!);
  assert.deepEqual(calls, ["preview", "variants", "upload"]);
  assert.equal(dom.document.querySelector(".fy-swimage-menu"), null);
});

it("keeps empty-frame actions honest and closes the image popover with Escape", async () => {
  const { container, calls } = await mount({ framePath: null, variants: 0, canUpload: false, canClear: false });
  const buttons = [...container.querySelectorAll(".fy-swrow__frameactions > button")] as HTMLButtonElement[];
  assert.deepEqual(buttons.map((button) => button.disabled), [true, true, true, false]);
  await click(buttons[3]!);
  const menu = dom.document.querySelector(".fy-swimage-menu")!;
  assert.ok((menu.querySelector("button") as HTMLButtonElement).disabled);
  assert.ok((menu.querySelectorAll("button")[1] as HTMLButtonElement).disabled);
  const event = new dom.window.Event("keydown", { bubbles: true });
  Object.defineProperty(event, "key", { value: "Escape" });
  await act(async () => dom.document.dispatchEvent(event));
  assert.equal(dom.document.querySelector(".fy-swimage-menu"), null);
  assert.deepEqual(calls, []);
});
