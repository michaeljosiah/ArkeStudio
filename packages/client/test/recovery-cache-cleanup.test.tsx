import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { CACHE_CLEANUP_POLICY, type ClientMessage, type RecoveryActionResult } from "@arke-studio/contracts";
import { RecoveryCacheCleanupControls } from "../src/components/recovery-cache-cleanup.js";
import { __setStateForTest, __setBridgeForTest, __applyEventForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("reviews before approving cleanup, bounds duplicate clicks and never replays after reconnect", async () => {
  const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Element: dom.Element, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const state = structuredClone(FIXTURE_STATE);
  state.app.recoveryPolicy = { audit: "available", accepting: true, mode: "suggest-only", targets: [], cleanup: { available: true, pending: false } };
  __setStateForTest(state, { connection: "open" }); const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!;
  const respond = (result: RecoveryActionResult) => act(async () => __applyEventForTest({ type: "recovery.action-result", at: new Date().toISOString(), result }));
  try {
    await act(async () => root.render(<RecoveryCacheCleanupControls />)); assert.equal(sent.length, 0);
    await act(async () => { button("Review previews…").click(); button("Review previews…").click(); }); assert.equal(sent.length, 1);
    const review = sent[0]!; assert(review.kind === "recovery-action"); assert.equal(review.command.action, "preview-cleanup");
    const preparedAt = Date.now();
    const plan = { id: "b".repeat(64), action: "cleanup-local-preset-previews" as const, evidence: "a".repeat(64), policyRevision: 1 as const,
      preparedAt, expiresAt: preparedAt + 300000, category: "fixed-local-preset-previews" as const,
      files: 1, logicalBytes: 256, allocatedBytes: 4096, minAgeMs: CACHE_CLEANUP_POLICY.minAgeMs, stopAtAvailableBytes: null,
      targets: [{ resourceKey: "c".repeat(64), createdAt: 0, logicalBytes: 256, allocatedBytes: 4096 }],
      replaysJobs: false as const, interruptsWork: false as const, undoable: false as const };
    await respond({ requestId: review.requestId, status: "preview", cleanupPlan: plan });
    assert(container.textContent?.includes("Deletion cannot be undone")); assert.equal(sent.length, 1);
    await act(async () => { button("Approve this cleanup").click(); button("Approve this cleanup")?.click(); }); assert.equal(sent.length, 2);
    const approval = sent[1]!; assert(approval.kind === "recovery-action"); assert.deepEqual(approval.command, { action: "approve-cleanup", planId: plan.id });
    await respond({ requestId: approval.requestId, status: "accepted", cleanupPlan: plan }); assert(button("Cancel remaining cleanup"));
    await act(async () => __setStateForTest(state, { connection: "closed" })); assert(container.textContent?.includes("will not be sent again"));
    const count = sent.length; await act(async () => __setStateForTest(state, { connection: "open" })); assert.equal(sent.length, count);
    const meta = document.createElement("meta"); meta.name = "arke-remote"; meta.content = "true"; document.head.append(meta);
    await act(async () => root.render(<RecoveryCacheCleanupControls />)); assert(button("Review previews…").disabled);
  } finally { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); }
});

it("checks an uncertain cleanup without granting deletion and preserves held outcomes and remote refusal", async () => {
  const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Element: dom.Element, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const state = structuredClone(FIXTURE_STATE);
  state.app.recoveryPolicy = { audit: "available", accepting: true, mode: "suggest-only", targets: [], cleanup: { available: false, pending: true, audit: "available" } };
  __setStateForTest(state, { connection: "open" }); const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const button = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Check cleanup outcome")!;
  const respond = (result: RecoveryActionResult) => act(async () => __applyEventForTest({ type: "recovery.action-result", at: new Date().toISOString(), result }));
  try {
    await act(async () => root.render(<RecoveryCacheCleanupControls />)); assert.equal(sent.length, 0);
    await act(async () => { button().click(); button().click(); }); assert.equal(sent.length, 1);
    const first = sent[0]!; assert(first.kind === "recovery-action"); assert.deepEqual(first.command, { action: "reconcile-cleanup" });
    await respond({ requestId: first.requestId, status: "accepted" }); assert(container.textContent?.includes("No deletion will be repeated"));
    await respond({ requestId: first.requestId, status: "unknown", reconciliation: { outcome: "unconfirmed", availableBytes: null } });
    assert(container.textContent?.includes("its hold remains")); assert.equal(sent.length, 1);
    await act(async () => button().click()); const second = sent[1]!; assert(second.kind === "recovery-action");
    await respond({ requestId: second.requestId, status: "verified", reconciliation: { outcome: "retained", availableBytes: 1000 } });
    assert(container.textContent?.includes("original audition is intact")); assert(container.textContent?.includes("No deletion was repeated"));
    assert(sent.every(message => message.kind === "recovery-action" && message.command.action === "reconcile-cleanup"));
    const meta = document.createElement("meta"); meta.name = "arke-remote"; meta.content = "true"; document.head.append(meta);
    await act(async () => root.render(<RecoveryCacheCleanupControls />)); assert(button().disabled);
  } finally { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); }
});

it("opens a warning's exact scope without sending work, discards late reviews and preserves an already sent approval", async () => {
  const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Element: dom.Element, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const state = structuredClone(FIXTURE_STATE), first = "d".repeat(64), second = "e".repeat(64);
  state.app.recoveryPolicy = { audit: "available", accepting: true, mode: "suggest-only", targets: [], cleanup: { available: true, pending: false,
    scope: { revision: first, volumeId: "volume-a", mappingRevision: "mount-a", measuredAt: Date.now(), inventoryAt: Date.now(), candidateFiles: 1, recordedBytes: 60 } } };
  __setStateForTest(state, { connection: "open" }); const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text);
  const respond = (result: RecoveryActionResult) => act(async () => __applyEventForTest({ type: "recovery.action-result", at: new Date().toISOString(), result }));
  const preparedAt = Date.now();
  const plan = { id: "b".repeat(64), action: "cleanup-local-preset-previews" as const, evidence: "a".repeat(64), policyRevision: 1 as const,
    scope: first, preparedAt, expiresAt: preparedAt + 300000, category: "fixed-local-preset-previews" as const,
    files: 1, logicalBytes: 60, allocatedBytes: 4096, minAgeMs: CACHE_CLEANUP_POLICY.minAgeMs, stopAtAvailableBytes: null,
    targets: [{ resourceKey: "c".repeat(64), createdAt: 0, logicalBytes: 60, allocatedBytes: 4096 }],
    replaysJobs: false as const, interruptsWork: false as const, undoable: false as const };
  try {
    for (const malformed of ["", "PRIVATE_PATH", "D".repeat(64)]) {
      await act(async () => root.render(<RecoveryCacheCleanupControls scope={malformed} />));
      assert(button("Review previews…")!.disabled); assert.equal(sent.length, 0);
    }
    await act(async () => root.render(<RecoveryCacheCleanupControls scope={first} />));
    assert.equal(sent.length, 0); assert(!button("Review previews…")!.disabled);
    await act(async () => button("Review previews…")!.click()); const old = sent[0]!; assert(old.kind === "recovery-action");
    assert.deepEqual(old.command, { action: "preview-cleanup", scope: first });
    await act(async () => root.render(<RecoveryCacheCleanupControls scope={second} />));
    await respond({ requestId: old.requestId, status: "preview", cleanupPlan: plan });
    assert(!button("Approve this cleanup")); assert(button("Review previews…")!.disabled); assert.equal(sent.length, 1);
    state.app.recoveryPolicy.cleanup!.scope!.revision = second;
    await act(async () => __setStateForTest(structuredClone(state), { connection: "open" }));
    await act(async () => button("Review previews…")!.click()); const review = sent[1]!; assert(review.kind === "recovery-action");
    assert.deepEqual(review.command, { action: "preview-cleanup", scope: second });
    await respond({ requestId: review.requestId, status: "preview", cleanupPlan: { ...plan, scope: second } });
    await act(async () => root.render(<RecoveryCacheCleanupControls scope={first} />));
    const cancel = sent[2]!; assert(cancel.kind === "recovery-action"); assert.deepEqual(cancel.command, { action: "cancel", planId: plan.id });
    assert(!button("Approve this cleanup"));
    await act(async () => root.render(<RecoveryCacheCleanupControls scope={second} />));
    await act(async () => button("Review previews…")!.click()); const current = sent[3]!; assert(current.kind === "recovery-action");
    await respond({ requestId: current.requestId, status: "preview", cleanupPlan: { ...plan, scope: second } });
    await act(async () => button("Approve this cleanup")!.click()); const approval = sent[4]!; assert(approval.kind === "recovery-action");
    await act(async () => root.render(<RecoveryCacheCleanupControls scope={first} />)); assert.equal(sent.length, 5);
    await respond({ requestId: approval.requestId, status: "accepted", cleanupPlan: { ...plan, scope: second } });
    assert(button("Cancel remaining cleanup"));
    await respond({ requestId: approval.requestId, status: "verified", cleanupPlan: { ...plan, scope: second },
      cleanup: { removedFiles: 1, logicalBytes: 60, availableBefore: null, availableAfter: null, reclaimedBytes: null } });
    assert.equal(sent.length, 5); assert(container.textContent?.includes("Confirmed removals: 1")); assert(!button("Cancel remaining cleanup"));
    await act(async () => root.render(<RecoveryCacheCleanupControls scope={second} />));
    await act(async () => button("Review previews…")!.click()); const disconnected = sent[5]!; assert(disconnected.kind === "recovery-action");
    await respond({ requestId: disconnected.requestId, status: "preview", cleanupPlan: { ...plan, scope: second } });
    await act(async () => __setStateForTest(structuredClone(state), { connection: "closed" }));
    await act(async () => root.render(<RecoveryCacheCleanupControls scope={first} />));
    assert.equal(sent.length, 6, "navigation cannot send a cancellation while disconnected"); assert(!button("Approve this cleanup"));
  } finally { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); }
});
