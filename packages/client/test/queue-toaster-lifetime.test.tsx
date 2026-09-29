import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { Link, MemoryRouter, useLocation } from "react-router";
import { toast } from "sonner";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { QueueToaster } from "../src/components/queue-toaster.js";
import { __applyEventForTest, __pendingQueueRequestsForTest, __setBridgeForTest, __setStateForTest, generateMainPhoto } from "../src/lib/store.js";
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

async function mount(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const tick = async (ms: number) => { await act(async () => t.mock.timers.tick(ms)); };
  __setStateForTest(FIXTURE_STATE);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => toast.dismiss());
    await tick(0);
    await tick(400);
    await act(async () => root.unmount());
    container.remove();
    __setBridgeForTest(null);
    t.mock.timers.reset();
  });
  await act(async () => root.render(<MemoryRouter><QueueToaster /><Page /></MemoryRouter>));
  return { container, tick };
}

it("expires receipts and refusals across navigation even after a pointer is released outside the toaster (issue 1001)", async (t) => {
    const { container, tick } = await mount(t);
    await act(async () => {
      __applyEventForTest({ type: "job.ready", at: "2026-09-08T12:00:00Z", job: { ...FIXTURE_STATE.app.jobs[0]!, status: "succeeded" } });
      __applyEventForTest({ type: "scene.write-refused", at: "2026-09-08T12:00:00Z", worldId: FIXTURE_STATE.world!.meta.worldId, productionId: "saltlight", sceneFile: "01.md", reason: "Scene changed on disk." });
      __applyEventForTest({ type: "command.failed", at: "2026-09-08T12:00:00Z", command: "bench-dispatch", requestId: "command-failure", reason: "Could not start generation." });
    });
    await tick(0); // Sonner publishes the notification on its next task.
    assert.match(container.textContent!, /ready/);
    assert.match(container.textContent!, /Scene changed on disk/);
    assert.match(container.textContent!, /Could not start generation/);
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
    assert.match(container.textContent!, /Could not start generation/);
    await tick(5600);
    await tick(0);
    await tick(400);
    assert.doesNotMatch(container.textContent!, /Scene changed on disk/);
    assert.doesNotMatch(container.textContent!, /Could not start generation/);
});

it("gives a repeated scene refusal a fresh twelve seconds", async (t) => {
  const { container, tick } = await mount(t);
  const refuse = async (reason: string) => {
    await act(async () => __applyEventForTest({ type: "scene.write-refused", at: "2026-09-08T12:00:00Z", worldId: FIXTURE_STATE.world!.meta.worldId, productionId: "saltlight", sceneFile: "01.md", reason }));
    await tick(0);
  };
  await refuse("Scene changed on disk.");
  await tick(11000);
  await refuse("Scene is no longer present.");
  assert.equal(container.querySelectorAll(".fy-note").length, 1);
  await tick(11999);
  assert.match(container.textContent!, /Scene is no longer present/);
  await tick(1);
  await tick(0);
  await tick(400);
  assert.doesNotMatch(container.textContent!, /Scene is no longer present/);
});

it("announces a failed job after its queued receipt expires without replaying the failure on store updates", async (t) => {
  const { container, tick } = await mount(t);
  __setBridgeForTest({ send: () => {} } as unknown as ArkeBridge);
  const job = { ...FIXTURE_STATE.app.jobs[0]!, status: "queued" as const };
  await act(async () => {
    __setStateForTest({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, jobs: [job] } });
    generateMainPhoto(job.worldId, "maren-kest", "a portrait", 1, []);
    __applyEventForTest({ type: "queue.enqueue-result", at: job.createdAt, requestId: __pendingQueueRequestsForTest().at(-1)!, command: "generate-main-photo", disposition: "accepted", requestedCount: 1, acceptedJobIds: [job.id], failures: [] });
  });
  await tick(0);
  assert.match(container.textContent!, /queued/);
  await tick(6000);
  await tick(0);
  await tick(400);
  assert.equal(container.querySelectorAll(".fy-note").length, 0);

  const failed = { ...job, status: "failed" as const, error: "Provider ran out of memory." };
  await act(async () => __applyEventForTest({ type: "job.updated", at: job.updatedAt, job: failed }));
  await tick(0);
  assert.match(container.textContent!, /Provider ran out of memory/);
  await tick(11999);
  assert.match(container.textContent!, /Provider ran out of memory/);
  await tick(1);
  await tick(0);
  await tick(400);
  assert.equal(container.querySelectorAll(".fy-note").length, 0);
  await act(async () => __applyEventForTest({ type: "job.updated", at: job.updatedAt, job: failed }));
  await tick(0);
  assert.equal(container.querySelectorAll(".fy-note").length, 0);
});
