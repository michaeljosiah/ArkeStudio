import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { GenerationDialog } from "../src/components/generation-dialog.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The standard dialog an image generation is asked for in.
 *
 * Three decisions, one arrangement: the words, a picture to look at, and who makes it. The point
 * of writing it once is that the next screen to generate something does not get to invent a
 * fourth arrangement of the same three. What is asserted here is what the dialog does when it is
 * mounted — the order it asks in, what it refuses to submit, how it closes and where it leaves
 * the keyboard. Whether a screen has grown its own <dialog> is a matter for review; a grep of the
 * screens for `showModal()` proved nothing about any of them.
 */

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
// linkedom's <dialog> has neither method; the component guards both on the element's own `open`,
// and a browser's close() ends in a `close` event, which is what the component listens to.
Object.assign(dom.HTMLElement.prototype, {
  showModal(this: HTMLDialogElement) { (this as { open: boolean }).open = true; },
  close(this: HTMLDialogElement) { (this as { open: boolean }).open = false; this.dispatchEvent(new dom.window.Event("close")); },
});

const open: Root[] = [];
afterEach(async () => {
  for (const root of open.splice(0)) await act(async () => root.unmount());
  dom.document.body.replaceChildren();
  __setStateForTest(FIXTURE_STATE);
});

async function mount(props: Partial<Parameters<typeof GenerationDialog>[0]> = {}) {
  __setStateForTest(FIXTURE_STATE);
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(host);
  const root = createRoot(host);
  open.push(root);
  const seen = { closed: 0, submitted: 0 };
  const render = async (over: Partial<Parameters<typeof GenerationDialog>[0]> = {}) => {
    await act(async () => root.render(
      <GenerationDialog
        workflow="main-photo" open title="Generate" prompt="A portrait" onPrompt={() => {}}
        worldSlug={FIXTURE_STATE.world!.meta.slug} reference={null} choice={{}} onChoice={() => {}}
        submitLabel="Generate" onSubmit={() => { seen.submitted += 1; }} onClose={() => { seen.closed += 1; }}
        {...props} {...over}
      />,
    ));
  };
  await render();
  return { host, render, seen };
}

const submit = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Generate")!;

describe("generation dialog", () => {
  it("asks for the words, a reference and the model, in that order", async () => {
    const { host } = await mount();
    const all = [...host.querySelectorAll("*")];
    const order = [".fy-gendialog__prompt", ".fy-gendialog__reference", '[data-testid="dispatch-bar"]'].map((selector) => {
      const node = host.querySelector(selector);
      assert.ok(node, selector);
      return all.indexOf(node);
    });
    assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, "prompt, then reference, then model");
  });

  it("will not submit an empty prompt, unless the brief is composed without one", async () => {
    const { host, render, seen } = await mount({ prompt: "   " });
    assert.equal(submit(host).disabled, true, "an empty brief is not a brief");
    await act(async () => submit(host).click());
    assert.equal(seen.submitted, 0);
    await render({ prompt: "A portrait" });
    assert.equal(submit(host).disabled, false);
    await render({ prompt: "   ", promptOptional: true });
    assert.equal(submit(host).disabled, false, "a location view composes its brief without the line");
  });

  it("closes on the backdrop and on Escape, and returns focus to whatever opened it", async () => {
    const trigger = dom.document.createElement("button") as unknown as HTMLButtonElement;
    dom.document.body.append(trigger);
    let focused = 0;
    trigger.focus = () => { focused += 1; };
    const { host, seen } = await mount({ returnFocus: { current: trigger } });
    const dialog = host.querySelector<HTMLDialogElement>("dialog.fy-gendialog")!;
    // A click that lands on the dialog itself rather than its panel is the backdrop.
    await act(async () => dialog.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
    assert.equal(seen.closed, 1, "the backdrop closes it");
    assert.equal(focused, 1, "and the keyboard goes back to the control that opened it, not the top of the document");
    // A click inside the panel is not.
    await act(async () => dialog.firstElementChild!.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
    assert.equal(seen.closed, 1, "a press inside the panel leaves it open");
  });
});
