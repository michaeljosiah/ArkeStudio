import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ClientMessage, RecoveryActionResult, RecoveryMingCleanupPlan } from "@arke-studio/contracts";
import { RecoveryMingCleanupControls } from "../src/components/recovery-ming-cleanup.js";
import { __setStateForTest, __setBridgeForTest, __applyEventForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("reviews one original worker before approval, drops stale reviews and never replays after disconnect", async () => {
  const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Element: dom.Element, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const state = structuredClone(FIXTURE_STATE), scope = "d".repeat(64), second = "e".repeat(64), at = Date.now();
  state.app.recoveryPolicy = { audit: "unavailable", accepting: false, mode: "suggest-only", targets: [], mingCleanup: {
    state: "held", scope, available: true, authority: "original-worker", waiting: 2, measuredAt: at, confirmation: null } };
  __setStateForTest(state, { connection: "open" }); const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text);
  const respond = (result: RecoveryActionResult) => act(async () => __applyEventForTest({ type: "recovery.action-result", at: new Date().toISOString(), result }));
  const plan: RecoveryMingCleanupPlan = { id: "b".repeat(64), scope, action: "confirm-ming-cleanup", preparedAt: at, expiresAt: at + 300_000,
    authority: "retained-original-worker", startsInference: false, replaysJobs: false, releasesGpuOnlyAfterConfirmedExit: true };
  const commandAt = (index: number) => { const command = sent[index]; assert(command?.kind === "recovery-action"); return command; };
  try {
    await act(async () => root.render(<RecoveryMingCleanupControls scope={scope} />)); assert.equal(sent.length, 0);
    assert(!button("Review Ming cleanup…")!.disabled, "protective original cleanup survives general recovery audit failure");
    await act(async () => { button("Review Ming cleanup…")!.click(); button("Review Ming cleanup…")!.click(); }); assert.equal(sent.length, 1);
    const stale = commandAt(0); assert.deepEqual(stale.command, { action: "preview-ming-cleanup", scope });
    await act(async () => root.render(<RecoveryMingCleanupControls scope={second} />));
    await respond({ requestId: stale.requestId, status: "preview", mingPlan: plan }); assert(!button("Approve Ming cleanup"));
    await act(async () => root.render(<RecoveryMingCleanupControls scope={scope} />));
    await act(async () => button("Review Ming cleanup…")!.click()); const review = commandAt(1);
    await respond({ requestId: review.requestId, status: "preview", mingPlan: plan }); assert.equal(sent.length, 2);
    assert(container.textContent?.includes("May terminate remaining processes"));
    await act(async () => { button("Approve Ming cleanup")!.click(); button("Approve Ming cleanup")?.click(); }); assert.equal(sent.length, 3);
    const approval = commandAt(2); assert.deepEqual(approval.command, { action: "approve-ming-cleanup", planId: plan.id });
    await act(async () => root.render(<RecoveryMingCleanupControls scope={second} />));
    await respond({ requestId: approval.requestId, status: "accepted", mingPlan: plan }); assert(button("Stop waiting for cleanup"));
    await respond({ requestId: approval.requestId, status: "verified", mingPlan: plan }); assert(container.textContent?.includes("Submitted narration keeps its original outcome"));
    await act(async () => root.render(<RecoveryMingCleanupControls scope={scope} />));
    await act(async () => button("Review Ming cleanup…")!.click()); const pending = commandAt(3);
    await act(async () => __setStateForTest(state, { connection: "closed" }));
    await respond({ requestId: pending.requestId, status: "preview", mingPlan: plan });
    assert(!button("Approve Ming cleanup")); assert(container.textContent?.includes("will not be sent again"));
    await act(async () => __setStateForTest(state, { connection: "open" })); assert.equal(sent.length, 4);
    const meta = document.createElement("meta"); meta.name = "arke-remote"; meta.content = "true"; document.head.append(meta);
    await act(async () => root.render(<RecoveryMingCleanupControls scope={scope} />)); assert(button("Review Ming cleanup…")!.disabled);
  } finally { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); }
});
