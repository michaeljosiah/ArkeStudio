import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChapterLookSheet } from "../src/components/chapter-look-sheet.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
let headHeight = 64;
Object.assign(dom.window, {
  innerHeight: 844,
  matchMedia: () => ({ matches: true }),
  getComputedStyle: () => ({ direction: "ltr", getPropertyValue: () => "20px", lineHeight: "24px", fontSize: "16px", paddingTop: "16px", paddingBottom: "16px" }),
});
Object.assign(dom.HTMLElement.prototype, {
  focus() {},
  getBoundingClientRect(this: HTMLElement) {
    const height = this.classList.contains("fy-page-sheet__head") ? headHeight : this.classList.contains("fy-page-sheet__foot") ? 64 : 0;
    const bottom = this.classList.contains("fy-titlebar") ? 48 : this.classList.contains("fy-scene-back") ? 92 : height;
    return { top: 0, bottom, height, left: 0, right: 390, width: 390 };
  },
  showModal(this: HTMLElement) { this.setAttribute("open", ""); },
  close(this: HTMLElement) { this.removeAttribute("open"); },
});
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null; dom.document.body.innerHTML = ""; dom.window.innerHeight = 844; headHeight = 64;
});
async function mount(chapter: boolean) {
  if (chapter) dom.document.body.innerHTML = '<div class="fy-production-app"><header class="fy-titlebar"></header><main data-screen="chapter"><nav class="fy-scene-back"></nav></main></div>';
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => root!.render(<ChapterLookSheet open title="Looks" onClose={() => {}} footer={<button>Done</button>}><p>One line of content</p></ChapterLookSheet>));
  return dom.document.querySelector("dialog") as unknown as HTMLDialogElement;
}

describe("chapter-owned look sheet chrome", () => {
  it("uses real chapter bars and the safe inset, adapting to short or enlarged-content windows", async () => {
    const dialog = await mount(true);
    assert.ok(dialog.classList.contains("fy-chapter-look-sheet"));
    assert.equal(dialog.style.getPropertyValue("--chapter-look-top"), "92px");
    assert.equal(dialog.style.getPropertyValue("--chapter-look-bottom"), "20px");
    dom.window.innerHeight = 190;
    await act(async () => dom.window.dispatchEvent(new Event("resize")));
    assert.equal(dialog.style.getPropertyValue("--chapter-look-top"), "0px", "one usable line no longer fits below the real chrome");
    assert.equal(dialog.style.getPropertyValue("--chapter-look-bottom"), "0px");
    dom.window.innerHeight = 420; headHeight = 240;
    await act(async () => dom.window.dispatchEvent(new Event("resize")));
    assert.equal(dialog.style.getPropertyValue("--chapter-look-top"), "0px", "enlarged sheet controls use the same fallback");
    dom.window.innerHeight = 844;
    await act(async () => dom.window.dispatchEvent(new Event("resize")));
    assert.equal(dialog.style.getPropertyValue("--chapter-look-top"), "92px");
    await act(async () => root!.unmount()); root = null;
    assert.equal(dialog.classList.contains("fy-chapter-look-sheet"), false);
    assert.equal(dialog.style.getPropertyValue("--chapter-look-top"), undefined);
  });
  it("leaves non-chapter sheet geometry alone", async () => {
    const dialog = await mount(false);
    assert.equal(dialog.classList.contains("fy-chapter-look-sheet"), false);
    assert.equal(dialog.style.getPropertyValue("--chapter-look-top"), undefined);
  });
});
