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
