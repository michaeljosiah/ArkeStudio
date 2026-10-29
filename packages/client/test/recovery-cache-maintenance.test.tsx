import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { CACHE_CLEANUP_POLICY, type ClientMessage, type RecoveryActionResult } from "@arke-studio/contracts";
import { RecoveryCacheMaintenanceControls } from "../src/components/recovery-cache-maintenance.js";
import { __setStateForTest, __setBridgeForTest, __applyEventForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("requires a scope review before opt-in, permits withdrawal during enable, and never repeats on reconnect", async () => {
  const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Element: dom.Element, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const state = structuredClone(FIXTURE_STATE), maintenance = { enabled: false, rootScope: "fixed-local-preset-previews" as const,
    minAgeMs: CACHE_CLEANUP_POLICY.minAgeMs, maxFiles: CACHE_CLEANUP_POLICY.maxFiles, maxBytes: CACHE_CLEANUP_POLICY.maxBytes, nextAttemptAt: 0 };
  state.app.recoveryPolicy = { audit: "available", accepting: true, mode: "automatic", targets: [], cleanup: { audit: "available", available: true, pending: false, maintenance } };
  __setStateForTest(state, { connection: "open" }); const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!;
  const respond = (result: RecoveryActionResult) => act(async () => __applyEventForTest({ type: "recovery.action-result", at: new Date().toISOString(), result }));
  try {
    await act(async () => root.render(<RecoveryCacheMaintenanceControls />)); assert.equal(sent.length, 0);
    await act(async () => button("Review automatic cleanup…").click()); assert.equal(sent.length, 0);
    for (const text of ["7 days old", "8 files", "2 GiB", "every 5 minutes", "cannot be undone"]) assert(container.textContent?.includes(text));
    await act(async () => button("Keep automatic cleanup off").click()); assert.equal(sent.length, 0);
    await act(async () => button("Review automatic cleanup…").click());
    await act(async () => { button("Enable automatic cleanup").click(); button("Enable automatic cleanup").click(); }); assert.equal(sent.length, 1);
    const enable = sent[0]!; assert(enable.kind === "recovery-action"); assert.deepEqual(enable.command, { action: "set-cleanup-maintenance", enabled: true });
    maintenance.enabled = true; await act(async () => __setStateForTest(state, { connection: "open" }));
    await act(async () => { button("Disable automatic cleanup").click(); button("Disable automatic cleanup").click(); }); assert.equal(sent.length, 2);
    const disable = sent[1]!; assert(disable.kind === "recovery-action"); assert.deepEqual(disable.command, { action: "set-cleanup-maintenance", enabled: false });
    await respond({ requestId: enable.requestId, status: "verified", maintenanceSaved: true }); assert(!container.textContent?.includes("enabled on this PC"));
    await respond({ requestId: disable.requestId, status: "verified", maintenanceSaved: false }); assert(container.textContent?.includes("is disabled"));
    await act(async () => __setStateForTest(state, { connection: "closed" })); await act(async () => __setStateForTest(state, { connection: "open" })); assert.equal(sent.length, 2);
    const meta = document.createElement("meta"); meta.name = "arke-remote"; meta.content = "true"; document.head.append(meta);
    await act(async () => root.render(<RecoveryCacheMaintenanceControls />)); assert(button("Disable automatic cleanup").disabled);
  } finally { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); }
});
