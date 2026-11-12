import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { emptyRecoveryHistory, observeRecoveryIncidents, type ClientMessage, type RecoveryHistoryPage } from "@arke-studio/contracts";
import { RecoveryHistoryBrowser } from "../src/components/recovery-history.js";
import { __setStateForTest, __setBridgeForTest, __applyEventForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("reads beyond reconnect limits, refuses stale pagination and sends only correlated presentation controls", async () => {
  const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Element: dom.Element, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const now = Date.now(), revision = "b".repeat(64);
  const retained = observeRecoveryIncidents(emptyRecoveryHistory(), Array.from({ length: 51 }, (_, index) => ({ id: (index + 1).toString(16).padStart(64, "0"), observation: {
    key: (index + 1).toString(16).padStart(64, "0"), kind: "storage-pressure" as const, evidenceRevision: revision, observedAt: now, phase: "needs-user" as const,
    evidence: "fresh" as const, severity: "advisory" as const, facts: [],
  } })), now);
  const history = { at: now, audit: "available" as const, incidents: retained.incidents.slice(0, 1), activeCount: 51, resolvedCount: 0, limited: true, preferences: retained.preferences, overflow: retained.overflow };
  const state = structuredClone(FIXTURE_STATE); state.app.recoveryHistory = history; __setStateForTest(state, { connection: "open" });
  const sent: ClientMessage[] = []; __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const read = () => { const command = sent.at(-1)!; assert(command.kind === "recovery-history-read"); return command; };
  const page = (patch: Partial<RecoveryHistoryPage> = {}): RecoveryHistoryPage => ({ status: "ready", filter: "all", offset: 0, pageSize: 50, at: now, audit: "available", revision,
    totalCount: 51, incidents: retained.incidents.slice(0, 50), nextCursor: { revision, offset: 50 }, previousCursor: null, ...patch });
  const respond = async (value: RecoveryHistoryPage) => { const command = read(); await act(async () => __applyEventForTest({ type: "recovery.history-page", at: new Date(now).toISOString(), requestId: command.requestId, page: value })); };
  const button = (label: string) => [...container.querySelectorAll("button")].find(button => button.textContent === label)!;
  try {
    await act(async () => root.render(<RecoveryHistoryBrowser history={history} />)); assert.equal(read().query.filter, "all");
    assert(button("Acknowledge").hasAttribute("disabled")); await respond(page());
    assert.equal(container.querySelectorAll("[data-incident-id]").length, 50);
    await act(async () => button("Next").click()); assert.deepEqual(read().query.cursor, { revision, offset: 50 });
    await respond(page({ status: "stale", revision: "c".repeat(64), incidents: [], nextCursor: null }));
    assert.match(container.textContent!, /History changed/); assert.equal(container.querySelectorAll("[data-incident-id]").length, 0);
    await act(async () => button("Refresh history").click()); assert.equal(read().query.cursor, undefined); await respond(page());
    await act(async () => button("Snooze 1 hour").click());
    const command = sent.at(-1)!; assert(command.kind === "recovery-history-control"); assert.deepEqual(command.command, { action: "snooze-hour", incidentId: retained.incidents[0]!.id });
    assert(button("Next").hasAttribute("disabled")); const before = sent.length;
    await act(async () => __applyEventForTest({ type: "recovery.command-result", at: new Date(now).toISOString(), result: { requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", operation: command.kind, status: "saved" } }));
    assert.equal(sent.length, before);
    await act(async () => __applyEventForTest({ type: "recovery.command-result", at: new Date(now).toISOString(), result: { requestId: command.requestId, operation: command.kind, status: "saved" } }));
    assert.equal(read().query.cursor, undefined); await respond(page());
    await act(async () => __applyEventForTest({ type: "recovery.command-result", at: new Date(now).toISOString(), result: { requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAW", operation: "recovery-history-control", historyAction: "clear-resolved", status: "saved" } }));
    assert.equal(read().query.cursor, undefined, "a summary clear from Settings invalidates retained pages"); await respond(page());
    const meta = document.createElement("meta"); meta.name = "arke-remote"; meta.content = "true"; document.head.append(meta);
    await act(async () => root.render(<RecoveryHistoryBrowser history={history} />)); assert(button("Acknowledge").hasAttribute("disabled")); assert(!button("Next").hasAttribute("disabled"));
    assert(sent.every(command => command.kind === "recovery-history-read" || command.kind === "recovery-history-control"));
  } finally { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); }
});
