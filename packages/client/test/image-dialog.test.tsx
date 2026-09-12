import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { ImageDialog } from "../src/components/image-dialog.js";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A world image opens larger where it stands.
 *
 * Three screens had grown their own copy of this and they had drifted: one disabled its trigger
 * until the picture loaded, two did not. What is asserted is the rendered trigger on each screen
 * that has one — disabled until the picture arrives, absent where the photo is a way in rather
 * than a thing to look at. Whether the dialog is implemented once is a matter for review, not a
 * grep of the source for `showModal()`.
 */

__setStateForTest(FIXTURE_STATE);

function renderAt(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const W = `/w/${FIXTURE_WORLD_ID}`;

describe("image dialog", () => {
  it("will not offer to enlarge a picture that has not arrived", () => {
    // Nothing has loaded in a server render, so no trigger may offer to enlarge anything yet.
    const html = renderAt(`${W}/cast/maren-kest/kit`);
    const at = html.indexOf('aria-label="View larger main photo of Maren Kest"');
    assert.ok(at > 0, "the trigger is rendered");
    const tag = html.slice(html.lastIndexOf("<button", at), html.indexOf(">", at) + 1);
    assert.match(tag, /\bdisabled\b/, "the trigger waits for the image");
  });

  /*
   * The detail page's main photo is a way in, not a thing to look at.
   *
   * It used to open a larger copy of itself — the one thing somebody looking at the picture
   * already has. What the anchor is for is the set it anchors, so it goes there instead. The
   * enlarge behaviour is unchanged everywhere it still makes sense, which the kit page below
   * holds; this asserts the detail page no longer has it at all.
   */
  it("sends the character's main photo to the identity reference set, rather than enlarging it", () => {
    const html = renderAt(`${W}/cast/maren-kest`);
    assert.ok(
      html.includes(`aria-label="Open Maren Kest&#x27;s identity reference set"`),
      "the anchor leads to the set it anchors",
    );
    assert.ok(
      !html.includes('aria-label="View larger main photo of Maren Kest"'),
      "and no longer offers a bigger copy of the picture already on screen",
    );
    assert.ok(!html.includes('aria-haspopup="dialog"'), "nothing on this page opens a dialog from the photo");
  });

  it("opens both panes of the reference page", () => {
    const html = renderAt(`${W}/cast/maren-kest/kit`);
    assert.ok(html.includes('aria-label="View larger main photo of Maren Kest"'), "the main photo opens");
    assert.ok(
      html.includes('aria-label="View larger character sheet for Maren Kest"'),
      "and so does the sheet beside it, which already did",
    );
  });

  /*
   * Availability belongs to a picture, not to the component.
   *
   * It used to be a bare boolean reset by an effect, which raced the load it was guarding: a
   * cached image settles during the first paint and the effect's mount pass then cleared it, so
   * the character detail page's main photo — preloaded by the cast page it is reached from — was
   * never clickable at all. Keying it to the subject decides the same thing during render, and
   * still cannot enable for the previous picture, because the key changes with the path.
   */
  it("enables for a picture that was already complete when it mounted, not for the next one until it is, and opens and closes from its own controls", async () => {
    const dom = parseHTML("<!doctype html><html><body></body></html>");
    Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
    Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
    // What the browser reports for an image the cache already had: complete, with a size, before
    // React can attach onLoad — and no load event to come.
    const image = Object.getPrototypeOf(dom.document.createElement("img")) as object;
    let cached = true;
    // linkedom's <dialog> has neither method; a browser's close() ends in a `close` event.
    Object.assign(dom.HTMLElement.prototype, {
      showModal(this: HTMLDialogElement) { (this as { open: boolean }).open = true; },
      close(this: HTMLDialogElement) { (this as { open: boolean }).open = false; this.dispatchEvent(new dom.window.Event("close")); },
    });
    Object.defineProperty(image, "complete", { configurable: true, get: () => cached });
    Object.defineProperty(image, "naturalWidth", { configurable: true, get: () => (cached ? 640 : 0) });
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.append(host);
    const root = createRoot(host);
    const render = (path: string) => act(async () => root.render(<ImageDialog worldSlug="w" path={path} label="Maren" title="Maren" triggerLabel="View larger main photo of Maren" triggerClassName="fy-portrait-trigger" />));
    const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
    try {
      await render("cast/maren/main.png");
      assert.equal(trigger().disabled, false, "a cached picture is available at once, with no load event");
      // The next picture is not cached: the trigger must not stay enabled on the strength of the last one.
      cached = false;
      await render("cast/maren/sheet.png");
      assert.equal(trigger().disabled, true, "a new subject starts unavailable");
      await act(async () => host.querySelector("img")!.dispatchEvent(new dom.window.Event("load")));
      assert.equal(trigger().disabled, false, "and becomes available when its own load arrives");

      // Open it, then out again by the backdrop and by the button; the keyboard comes back to the trigger each time.
      let focused = 0;
      trigger().focus = () => { focused += 1; };
      const dialog = () => host.querySelector<HTMLDialogElement>("dialog.fy-portrait-dialog")!;
      await act(async () => trigger().click());
      assert.equal(dialog().open, true, "the trigger opens the enlarged copy");
      await act(async () => dialog().dispatchEvent(new dom.window.Event("click", { bubbles: true })));
      assert.equal(dialog().open, false, "a click on the dialog itself — the backdrop — closes it");
      assert.equal(focused, 1, "and focus returns to the trigger");
      await act(async () => trigger().click());
      await act(async () => dialog().querySelector<HTMLElement>(".fy-portrait-dialog__panel")!.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
      assert.equal(dialog().open, true, "a click inside the panel does not");
      await act(async () => dialog().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
      assert.equal(dialog().open, false, "the close button does");
      assert.equal(focused, 2);
    } finally {
      await act(async () => root.unmount());
      delete (image as { complete?: unknown }).complete;
      delete (image as { naturalWidth?: unknown }).naturalWidth;
    }
  });
});
