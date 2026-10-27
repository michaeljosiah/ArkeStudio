import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ClientMessage, RecoveryActionResult } from "@arke-studio/contracts";
import { RecoveryRetryControls } from "../src/components/recovery-retry.js";
import { __setStateForTest, __setBridgeForTest, __applyEventForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
it("only previews on Review, requires exact approval, and never replays after reconnect", async () => {
  const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Element: dom.Element, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const state = structuredClone(FIXTURE_STATE), key = "a".repeat(64);
  state.app.recoveryPolicy = { audit: "available", accepting: true, mode: "suggest-only", targets: [{ key, service: "ollama", stoppedByUser: false, circuitOpen: true, pendingOutcome: false, retryAvailable: true }] };
  __setStateForTest(state, { connection: "open" }); const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!;
  const respond = (value: RecoveryActionResult) => act(async () => __applyEventForTest({ type: "recovery.action-result", at: new Date().toISOString(), result: value }));
  try {
    await act(async () => root.render(<RecoveryRetryControls />)); assert.equal(sent.length, 0);
    await act(async () => { button("Review retry…").click(); button("Review retry…").click(); }); assert.equal(sent.length, 1);
    const preview = sent[0]!; assert(preview.kind === "recovery-action" && preview.command.action === "preview-retry");
    const plan = { id: "b".repeat(64), resourceKey: key, action: "retry-managed-runtime" as const, service: "ollama" as const, evidence: "c".repeat(64), policyRevision: 1 as const,
      preparedAt: Date.now(), expiresAt: Date.now() + 300000, downloadBytes: 0 as const, diskBytes: null, interruptsWork: false as const, replaysJobs: false as const };
    await respond({ requestId: preview.requestId, status: "preview", plan });
    assert(container.textContent?.includes("extra space is unknown")); assert.equal(sent.length, 1);
    await act(async () => { button("Approve this retry").click(); button("Approve this retry")?.click(); }); assert.equal(sent.length, 2);
    const approval = sent[1]!; assert(approval.kind === "recovery-action"); assert.deepEqual(approval.command, { action: "approve-retry", planId: plan.id });
    await respond({ requestId: approval.requestId, status: "accepted", plan });
    assert(button("Cancel waiting retry"));
    await act(async () => __setStateForTest(state, { connection: "closed" })); assert(container.textContent?.includes("will not be sent again"));
    const count = sent.length; await act(async () => __setStateForTest(state, { connection: "open" })); assert.equal(sent.length, count);
    const meta = document.createElement("meta"); meta.name = "arke-remote"; meta.content = "true"; document.head.append(meta);
    await act(async () => root.render(<RecoveryRetryControls />)); assert(button("Review retry…").disabled);
  } finally { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); }
});
