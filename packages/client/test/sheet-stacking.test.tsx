import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { EditorDialog } from "../src/components/editor-dialog.js";
import { PageSheet } from "../src/components/page-sheet.js";
import { ResponsiveSheet } from "../src/components/responsive-sheet.js";

/**
 * A sheet opened over a block drawer stands in front of it (2026-10-04, 0.5.60-local.14). The
 * drawer is a modal `<dialog>`, which the browser draws above every z-index with the page under it
 * inert: at a window around 1,700 wide the block's `Title · title` drawer covered the Looks and
 * the Illustrate sheet. The drawer now gives way while a later sheet is open and comes back, with
 * what it held, when that sheet goes.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1700, innerHeight: 1000 });
Object.defineProperty(dom.document, "activeElement", { value: dom.document.body, configurable: true });
Object.assign(dom.HTMLElement.prototype, { focus(this: HTMLElement) {
  Object.defineProperty(dom.document, "activeElement", { value: this, configurable: true });
  this.dispatchEvent(new dom.Event("focusin", { bubbles: true }) as unknown as Event);
}, scrollIntoView() {} });
// linkedom draws no top layer: a modal dialog is one with `open` set by showModal, unset by close.
const dialogProto = Object.getPrototypeOf(dom.document.createElement("dialog"));
Object.assign(dialogProto, {
  showModal(this: HTMLElement) {
    this.setAttribute("open", "");
  },
  close(this: HTMLElement) {
    this.removeAttribute("open");
  },
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

let root: Root | null = null;
afterEach(async () => {
  if (root !== null) await act(async () => root!.unmount());
  root = null;
  dom.document.body.innerHTML = "";
  Object.defineProperty(dom.document, "activeElement", { value: dom.document.body, configurable: true });
});

let openQuote: (open: boolean) => void = () => {};
let openLooks: (open: boolean) => void = () => {};
function Page() {
  const [looks, setLooks] = useState(false);
  openLooks = setLooks;
  const [quote, setQuote] = useState(false);
  openQuote = setQuote;
  return (
    <>
      <ResponsiveSheet sheet open title="Title · title" onClose={() => {}} className="fy-chapter-block-sheet">
        <p data-testid="panel">the block's panel</p>
      </ResponsiveSheet>
      <EditorDialog open={looks} onClose={() => setLooks(false)} title="Looks · Chapter 1">
        <p data-testid="looks">the looks</p>
      </EditorDialog>
      <PageSheet open={quote} title="Read Chapter 1" onClose={() => setQuote(false)} className="read-quote"><button>Confirm read</button></PageSheet>
    </>
  );
}

describe("a sheet over the block drawer", () => {
  it("puts the drawer away while the sheet is open, keeping what it holds, and brings it back after", async () => {
    const container = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Page />));
    const drawer = dom.document.querySelector("dialog.fy-chapter-block-sheet")!;
    assert.ok(drawer.hasAttribute("open"), "the drawer shows");
    await act(async () => openLooks(true));
    assert.ok(dom.document.querySelector('[data-testid="looks"]'), "the Looks is open");
    assert.equal(drawer.hasAttribute("open"), false, "the drawer gives way: it no longer covers the sheet");
    assert.ok(dom.document.querySelector('[data-testid="panel"]'), "and keeps its panel mounted");
    await act(async () => openLooks(false));
    assert.ok(drawer.hasAttribute("open"), "the drawer is back once the sheet goes");
  });
  it("gives a newer read quote sole control, without closing the covered Looks on Escape", async () => {
    const container = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Page />));
    await act(async () => openLooks(true));
    const looks = dom.document.querySelector(".fy-editordialog")!;
    await act(async () => openQuote(true));
    assert.equal(dom.document.querySelectorAll("dialog[open]").length, 1);
    assert.equal(dom.document.querySelector("dialog[open]")?.classList.contains("read-quote"), true);
    assert.equal((looks as unknown as HTMLElement).style.display, "none");
    await act(async () => dom.window.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" })));
    assert.ok(dom.document.querySelector('[data-testid="looks"]'), "a covered sheet ignores keys");
    await act(async () => dom.document.querySelector(".read-quote")!.dispatchEvent(new Event("cancel", { cancelable: true })));
    assert.equal((looks as unknown as HTMLElement).style.display ?? "", "");
    assert.equal(dom.document.querySelectorAll("dialog[open]").length, 0, "the layer resumes above the still-hidden drawer");
    await act(async () => openLooks(false));
    assert.equal(dom.document.querySelectorAll("dialog[open]").length, 1);
    assert.equal(dom.document.querySelector("dialog[open]")?.classList.contains("fy-chapter-block-sheet"), true);
  });

});

function FocusPage() {
  const [open, setOpen] = useState(false), [animate, setAnimate] = useState(false);
  return <>
    <button data-testid="opener" onClick={() => setOpen(true)}>Open block 2</button>
    <ResponsiveSheet sheet open={open} title="Block 2" onClose={() => setOpen(false)} preserveReturnFocus>
      <textarea defaultValue="held prompt" />
      <button data-testid="animate" onClick={() => setAnimate(true)}>Animate</button>
    </ResponsiveSheet>
    <EditorDialog open={animate} onClose={() => setAnimate(false)} title="Animate">
      <button data-testid="back" onClick={() => setAnimate(false)}>Back</button>
    </EditorDialog>
  </>;
}

describe("responsive block focus (issue 1688)", () => {
  it("resumes the nested opener and retained draft after Escape or Back", async () => {
    const container = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<FocusPage />));
    const get = (id: string) => dom.document.querySelector('[data-testid="' + id + '"]') as unknown as HTMLElement;
    const press = async (element: HTMLElement) => act(async () => {
      element.focus();
      element.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event);
    });
    for (const close of ["escape", "button"] as const) {
      await press(get("opener"));
      const drawer = dom.document.querySelector("dialog")!;
      const draft = drawer.querySelector("textarea")!;
      draft.value = "held prompt";
      await press(get("animate"));
      assert.equal(drawer.hasAttribute("open"), false, "only the newer dialog is active");
      if (close === "escape") await act(async () => dom.window.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" })));
      else await press(get("back"));
      assert.equal(dom.document.activeElement?.getAttribute("data-testid"), "animate", "the exact nested opener resumes");
      assert.ok(drawer.querySelector("textarea") === draft, "the retained draft is not remounted");
      assert.equal(draft.value, "held prompt");
      await act(async () => drawer.dispatchEvent(new Event("cancel", { cancelable: true })));
      assert.equal(drawer.hasAttribute("open"), false, "the parent can still close normally");
      // Native dialog opener restoration is checked in the full-App browser matrix; linkedom has no top layer.
    }
  });
});
