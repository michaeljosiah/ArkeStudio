import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { Link, MemoryRouter, useLocation } from "react-router";
import { QueueToaster } from "../src/components/queue-toaster.js";
import { __applyEventForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }) });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

function Page() {
  return <><h1>{useLocation().pathname}</h1><Link to="/settings">Settings</Link></>;
}

it("expires receipts and refusals across navigation even after a pointer is released outside the toaster (issue 1001)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const tick = async (ms: number) => { await act(async () => t.mock.timers.tick(ms)); };
  __setStateForTest(FIXTURE_STATE);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><QueueToaster /><Page /></MemoryRouter>));
    await act(async () => {
      __applyEventForTest({ type: "job.ready", at: "2026-09-08T12:00:00Z", job: { ...FIXTURE_STATE.app.jobs[0]!, status: "succeeded" } });
      __applyEventForTest({ type: "scene.write-refused", at: "2026-09-08T12:00:00Z", worldId: FIXTURE_STATE.world!.meta.worldId, productionId: "saltlight", sceneFile: "01.md", reason: "Scene changed on disk." });
    });
    await tick(0); // Sonner publishes the notification on its next task.
    assert.match(container.textContent!, /ready/);
    assert.match(container.textContent!, /Scene changed on disk/);
    await tick(3000);

    const toaster = container.querySelector("[data-sonner-toaster]")!;
    await act(async () => {
      toaster.dispatchEvent(new dom.Event("mousemove", { bubbles: true }));
      toaster.dispatchEvent(new dom.Event("pointerdown", { bubbles: true }));
      document.body.dispatchEvent(new dom.Event("pointerup", { bubbles: true }));
      container.querySelector("a")!.dispatchEvent(Object.assign(new dom.Event("click", { bubbles: true, cancelable: true }), { button: 0 }));
      __setStateForTest({ ...FIXTURE_STATE });
    });
    assert.equal(container.querySelector("h1")!.textContent, "/settings");
    await tick(2999);
    assert.match(container.textContent!, /ready/);
    await tick(1);
    await tick(0); // dismissal frame
    await tick(400); // exit transition
    assert.doesNotMatch(container.textContent!, /ready/);
    assert.match(container.textContent!, /Scene changed on disk/);
    await tick(5600);
    await tick(0);
    await tick(400);
    assert.doesNotMatch(container.textContent!, /Scene changed on disk/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    t.mock.timers.reset();
  }
});
