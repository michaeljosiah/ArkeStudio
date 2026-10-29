import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { parseHTML } from "linkedom";
import { emptyRecoveryHistory, observeRecoveryIncident, computeNeedsYou, DomainEventSchema, type RecoveryHistorySnapshot, type ClientMessage } from "@arke-studio/contracts";
import { __applyForTest, __setStateForTest, __setBridgeForTest, __applyEventForTest, subscribeRecoveryNotices } from "../src/lib/store.js";
import { __resetActivityPanelForTest, openActivityPanel } from "../src/lib/activity-panel.js";
import { ActivityPanel } from "../src/components/activity-panel.js";
import { SettingsDiagnosticsScreen } from "../src/screens/settings-diagnostics.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const now = Date.parse("2026-10-26T16:00:00Z"), key = "a".repeat(64);
function history(): RecoveryHistorySnapshot {
  const value = observeRecoveryIncident(emptyRecoveryHistory(), { key, kind: "storage-pressure", evidenceRevision: "b".repeat(64), observedAt: now,
    phase: "needs-user", severity: "advisory", evidence: "fresh", facts: [{ name: "available-bytes", value: 2 * 1024 ** 3, measuredAt: now }] }, "c".repeat(64), now);
  return { at: now, audit: "available", incidents: value.incidents, activeCount: 1, resolvedCount: 0, limited: false, preferences: { transientMuted: true, desktopOptIn: false }, overflow: value.overflow };
}
function state() { const value = structuredClone(FIXTURE_STATE); value.app.recoveryHistory = history(); return value; }

it("only delivers new admitted notices, keeps muted incidents in state, and does not replay them when unmuted", () => {
  const value = state(); __setStateForTest(value); let delivered = 0;
  const unsubscribe = subscribeRecoveryNotices(() => { delivered++; });
  const notice = (at: number) => ({ type: "recovery.notice" as const, at: new Date(at).toISOString(), notice: { incidentId: "c".repeat(64), reason: "first-actionable" as const, at } });
  try {
    __applyEventForTest(notice(now)); assert.equal(delivered, 0);
    const unmuted = history(); unmuted.preferences.transientMuted = false;
    __applyEventForTest({ type: "recovery.history", at: new Date(now).toISOString(), history: unmuted });
    __applyEventForTest(notice(now)); assert.equal(delivered, 0);
    __applyEventForTest(notice(now + 1)); __applyEventForTest(notice(now + 1)); assert.equal(delivered, 1);
    __applyEventForTest({ type: "recovery.history", at: new Date(now).toISOString(), history: { ...unmuted, audit: "unavailable" } });
    __applyEventForTest(notice(now + 2)); assert.equal(delivered, 1);
  } finally { unsubscribe(); }
});

it("folds recovery snapshots and keeps muted incidents visible with a read-only global action", () => {
  const value = state(), event = DomainEventSchema.parse({ type: "recovery.history", at: new Date(now).toISOString(), history: history() });
  const next = __applyForTest(structuredClone(FIXTURE_STATE), event); assert.deepEqual(next.app.recoveryHistory, value.app.recoveryHistory); assert.deepEqual(next.world, FIXTURE_STATE.world);
  const entry = computeNeedsYou(next).find(value => value.kind === "local-ai-incident")!;
  assert.equal(entry.worldId, undefined); assert.deepEqual(entry.actions, ["diagnostics"]); assert.match(entry.detail, /2\.0 GiB available/);
});

it("renders bounded operational history using the existing Diagnostics rows without repair controls", () => {
  __setStateForTest(state(), { diagnostics: { derivedAt: new Date(now).toISOString(), findings: [], checked: [], sources: [] } });
  const html = renderToString(<MemoryRouter><SettingsDiagnosticsScreen /></MemoryRouter>);
  assert.match(html, /RECOVERY HISTORY/); assert.match(html, /Storage needs attention/); assert.match(html, /2\.0 GiB available/);
  const section = html.slice(html.indexOf('aria-label="Recovery history"')); assert(section.includes("Recovery history filter")); assert(section.includes("Snooze 1 hour")); assert(!section.includes("Restart"));
});

it("Review Diagnostics only navigates and never resumes a job or approves a repair", async () => {
  const dom = parseHTML("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Element: dom.Element, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  __resetActivityPanelForTest(); __setStateForTest(state(), { connection: "open" }); openActivityPanel("inbox");
  const sent: ClientMessage[] = []; __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={["/"]}><Routes><Route path="/" element={<ActivityPanel />} /><Route path="/settings/diagnostics" element={<p>Diagnostics destination</p>} /></Routes></MemoryRouter>));
    const before = sent.length, button = [...container.querySelectorAll("button")].find(button => button.textContent === "Review Diagnostics")!; assert(button);
    await act(async () => button.click()); assert.match(container.textContent!, /Diagnostics destination/); assert.equal(sent.length, before);
  } finally { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); __resetActivityPanelForTest(); }
});
