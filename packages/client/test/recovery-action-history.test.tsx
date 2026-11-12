import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ClientMessage, RecoveryActionSummary, RecoveryHistoryPage, RecoveryHistorySnapshot } from "@arke-studio/contracts";
import { RecoveryHistoryBrowser } from "../src/components/recovery-history.js";
import { __setStateForTest, __setBridgeForTest, __applyEventForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("reads chronological action pages without repair commands and keeps unconfirmed outcomes distinct from settled failures", async () => {
  const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Element: dom.Element, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const now = Date.now(), revision = "b".repeat(64), sent: ClientMessage[] = [];
  const actions: RecoveryActionSummary[] = [{ id: "a".repeat(64), resourceId: revision, action: "restart-managed-runtime", service: "ollama", automatic: true,
    authorizedAt: now - 1000, outcomeAt: now, outcome: "failed", evidence: "owner-receipt" },
  { id: "c".repeat(64), resourceId: revision, action: "cleanup-local-preset-previews", automatic: false, authorizedAt: null, outcomeAt: now - 1000, outcome: "unknown", evidence: "owner-receipt",
    cleanup: { removedFiles: 1, logicalBytes: 60, availableBefore: null, availableAfter: null, reclaimedBytes: null } }];
  const history: RecoveryHistorySnapshot = { at: now, audit: "available", incidents: [], activeCount: 0, resolvedCount: 0, limited: false, actions, actionCount: 2,
    settledActionCount: 1, unconfirmedActionCount: 1, preferences: { transientMuted: false, desktopOptIn: false }, overflow: { coalescedObservations: 0, prunedSummaries: 0, lostDetail: false } };
  const state = structuredClone(FIXTURE_STATE); state.app.recoveryHistory = history; __setStateForTest(state, { connection: "open" });
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const read = () => { const command = sent.at(-1)!; assert(command.kind === "recovery-history-read"); return command; };
  const respond = async (page: RecoveryHistoryPage) => {
    await act(async () => __applyEventForTest({ type: "recovery.history-page", at: new Date(now).toISOString(), requestId: read().requestId, page }));
  };
  const choose = (label: string, value: string) => act(async () => {
    const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    Object.defineProperty(select, "value", { value, configurable: true }); select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  const page = { status: "ready" as const, filter: "all" as const, offset: 0, pageSize: 50, at: now, audit: "available" as const, revision, totalCount: 0,
    incidents: [], nextCursor: null, previousCursor: null };
  try {
    await act(async () => root.render(<RecoveryHistoryBrowser history={history} />)); await respond(page);
    await choose("Recovery history view", "actions"); assert.deepEqual(read().query, { view: "actions", filter: "all", pageSize: 50 });
    await respond({ ...page, view: "actions", actions, totalCount: 2 });
    assert.equal(container.querySelectorAll("[data-recovery-action-id]").length, 2);
    assert(container.textContent?.includes("Ollama restart · Failed")); assert(container.textContent?.includes("Local preset preview cleanup · Unconfirmed"));
    assert(container.textContent?.includes("Confirmed removals: 1")); assert(container.textContent?.includes("1 unconfirmed · 1 settled"));
    assert(!container.querySelector("[data-incident-id]"));
    await choose("Recovery history filter", "active"); assert.equal(read().query.view, "actions"); assert.equal(read().query.filter, "active");
    await respond({ ...page, filter: "active", view: "actions", actions: [actions[1]!], totalCount: 1 });
    assert.equal(container.querySelectorAll("[data-recovery-action-id]").length, 1);
    await act(async () => __setStateForTest(state, { connection: "closed" }));
    await act(async () => __setStateForTest(state, { connection: "open" })); assert.equal(read().query.view, "actions");
    await respond({ ...page, status: "stale", view: "actions", filter: "active", actions: [], totalCount: 1 });
    assert.equal(container.querySelectorAll("[data-recovery-action-id]").length, 0); assert(container.textContent?.includes("History changed"));
    assert(sent.every(command => command.kind === "recovery-history-read"));
  } finally { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); }
});
