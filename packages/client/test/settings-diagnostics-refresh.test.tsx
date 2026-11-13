import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { deriveDiagnostics, diagnosticsSources, type ClientMessage } from "@arke-studio/contracts";
import { SettingsDiagnosticsScreen } from "../src/screens/settings-diagnostics.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });

it("measures hardware from Diagnostics and clears the finding when the measured snapshot arrives (#2238)", async () => {
  const now = new Date().toISOString(), state = structuredClone(FIXTURE_STATE), sent: ClientMessage[] = [];
  state.app.runtime = null;
  const snapshot = () => deriveDiagnostics({ sources: diagnosticsSources(state.app), tails: { appLog: [] }, previous: null, now });
  __setStateForTest(state, { connection: "open", diagnostics: snapshot() });
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={["/settings/diagnostics"]}><SettingsDiagnosticsScreen /></MemoryRouter>));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-kind="hardware-unmeasured"] .fy-diag__go')!.click());
    assert.equal(sent.filter(message => message.kind === "detect-runtimes").length, 1);
    state.app.runtime = { probes: { vramMb: 12288, memMb: 32768, diskFreeMb: 100000 }, detectedAt: now, models: [], recommended: {} };
    await act(async () => __setStateForTest(state, { connection: "open", diagnostics: snapshot() }));
    assert.equal(container.querySelector('[data-kind="hardware-unmeasured"]'), null);
  } finally { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); }
});

it("opens the exact Ming cleanup review without acting and refreshes stale owner evidence", async () => {
  for (const stale of [false, true]) {
    const at = Date.now(), now = new Date(at).toISOString(), sent: ClientMessage[] = [], state = structuredClone(FIXTURE_STATE);
    state.app.recoveryPolicy = { audit: "available", accepting: true, mode: "suggest-only", targets: [], mingCleanup: { state: "held", scope: "d".repeat(64),
      authority: "original-worker", available: true, waiting: 1, measuredAt: at - (stale ? 60_001 : 0), confirmation: null } };
    const snapshot = deriveDiagnostics({ sources: diagnosticsSources(state.app), tails: { appLog: [] }, previous: null, now });
    __setStateForTest(state, { connection: "open", diagnostics: snapshot });
    __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
    try {
      await act(async () => root.render(<MemoryRouter initialEntries={["/settings/diagnostics"]}><SettingsDiagnosticsScreen /></MemoryRouter>));
      const count = sent.filter(message => message.kind === "refresh-diagnostics").length;
      const row = container.querySelector('[data-kind="ming-cleanup-unconfirmed"]')!;
      await act(async () => row.querySelector<HTMLButtonElement>(".fy-diag__go")!.click());
      assert(!sent.some(message => message.kind === "recovery-action"));
      if (stale) assert.equal(sent.filter(message => message.kind === "refresh-diagnostics").length, count + 1);
      else assert(container.textContent?.includes("Opening this review starts no cleanup"));
    } finally { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); }
  }
});

it("requests storage measurement from the finding and stale Refresh without remounting Diagnostics", async () => {
  const now = new Date().toISOString(), sent: ClientMessage[] = [];
  const snapshot = deriveDiagnostics({ sources: diagnosticsSources({ ...FIXTURE_STATE.app,
    storageHealth: { at: Date.parse(now), writing: false, roots: [{ rootId: "media", role: "generated-media", state: "unavailable", source: "host-provided", limitations: ["probe-failed"], capacity: null, pressure: null, forecast: null }] },
  }), tails: { appLog: [] }, previous: null, now });
  const finding = snapshot.findings.find(value => value.kind === "storage-capacity-unknown")!;
  finding.stale = { facts: ["destinations"], remeasure: { control: "storage-refresh" } };
  __setStateForTest(FIXTURE_STATE, { connection: "open", diagnostics: snapshot });
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={["/settings/diagnostics"]}><SettingsDiagnosticsScreen /></MemoryRouter>));
    const count = () => sent.filter(message => message.kind === "refresh-diagnostics").length;
    assert.equal(count(), 1);
    const row = container.querySelector('[data-kind="storage-capacity-unknown"]')!;
    const refresh = row.querySelector<HTMLButtonElement>(".fy-diag__go")!;
    await act(async () => refresh.click()); assert.equal(count(), 2);
    assert.equal(container.querySelector('[data-kind="storage-capacity-unknown"]'), row);
    await act(async () => row.querySelector<HTMLButtonElement>(".fy-set__link")!.click()); assert.equal(count(), 3);
  } finally {
    await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null);
  }
});

it("follows a measured storage remedy to its scoped review without approving or previewing cleanup", async () => {
  const now = new Date().toISOString(), scope = "d".repeat(64), sent: ClientMessage[] = [], state = structuredClone(FIXTURE_STATE);
  state.app.storageHealth = { at: Date.parse(now), writing: false, roots: [{ rootId: "cache", role: "working-files", state: "measured", source: "host-provided",
    limitations: [], capacity: { volumeId: "volume-a", mappingRevision: "mount-a", measuredAt: Date.parse(now), availableBytes: 4 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }, pressure: null, forecast: null }] };
  state.app.recoveryPolicy = { audit: "available", accepting: true, mode: "suggest-only", targets: [], cleanup: { available: true, pending: false,
    scope: { revision: scope, volumeId: "volume-a", mappingRevision: "mount-a", measuredAt: Date.parse(now), inventoryAt: Date.parse(now), candidateFiles: 1, recordedBytes: 60 } } };
  const snapshot = deriveDiagnostics({ sources: diagnosticsSources(state.app), tails: { appLog: [] }, previous: null, now });
  __setStateForTest(state, { connection: "open", diagnostics: snapshot });
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={["/settings/diagnostics"]}><SettingsDiagnosticsScreen /></MemoryRouter>));
    const row = container.querySelector('[data-kind="storage-pressure"]')!;
    const remedy = row.querySelector<HTMLButtonElement>(".fy-diag__go")!; assert.equal(remedy.textContent, "Review preview cleanup");
    await act(async () => remedy.click());
    assert(!sent.some(message => message.kind === "recovery-action"));
    assert(container.textContent?.includes("volume named by the storage warning"));
    const review = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Review previews…")!;
    assert(!review.disabled); await act(async () => review.click());
    const actions = sent.filter(message => message.kind === "recovery-action"); assert.equal(actions.length, 1);
    assert.deepEqual(actions[0]!.command, { action: "preview-cleanup", scope });
  } finally { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); }
});
