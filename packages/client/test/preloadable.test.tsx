import assert from "node:assert/strict";
import { it } from "node:test";
import { act, Component, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { preloadable, retryFailedScreens } from "../src/lib/preloadable.js";

/** A screen loaded on demand (issue 2797), drawn into a DOM as the app draws it. */
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Element: dom.Element, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });

class Boundary extends Component<{ children: ReactNode }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? <p>could not be shown</p> : this.props.children; }
}

it("fails a screen whose chunk cannot arrive, without asking again and again, and draws it after the next navigation (codex on PR 2858)", { timeout: 10_000 }, async () => {
  let online = false, attempts = 0;
  const Screen = preloadable(async () => {
    attempts += 1;
    if (!online) throw new Error("Failed to fetch dynamically imported module");
    return () => <p>the screen</p>;
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const show = (key: number) => act(async () => root.render(<Boundary key={key}><Suspense fallback={<p>loading</p>}><Screen /></Suspense></Boundary>));
  const quietly = console.error;
  console.error = () => {};
  try {
    await show(1);
    assert.equal(container.textContent, "could not be shown", "offline, the chunk cannot arrive");
    assert.equal(attempts, 1, "asked once, not again each time React retried the screen");
    // The connection returns; navigating back to the screen retries it, as the route boundary does.
    online = true;
    retryFailedScreens();
    await show(2);
    assert.equal(container.textContent, "the screen");
    assert.equal(attempts, 2);
  } finally {
    console.error = quietly;
    await act(async () => root.unmount());
    container.remove();
  }
});
