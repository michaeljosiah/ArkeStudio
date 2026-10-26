import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { parseHTML } from "linkedom";
import { deriveDiagnostics, diagnosticsSources, unavailableSystemResources, type ClientMessage, type ClientState } from "@arke-studio/contracts";
import { SystemPanel, SystemStatusView } from "../src/components/system-panel.js";
import { AppChrome } from "../src/components/chrome.js";
import { closeSystemPanel } from "../src/lib/system-panel.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { SettingsDiagnosticsScreen } from "../src/screens/settings-diagnostics.js";

const now = 60_000, gib = 1024 ** 3;
const resources = unavailableSystemResources(now);
resources.cpu = { source: "node-os", state: "measured", measuredAt: now, value: 0 };
resources.memory = { source: "node-os", state: "measured", measuredAt: now, value: { usedBytes: 8 * gib, totalBytes: 16 * gib } };
const app: ClientState["app"] = { ...FIXTURE_STATE.app, systemResources: resources };
const view = (value: ClientState["app"], at = now, connected = true) => parseHTML(renderToString(<SystemStatusView app={value} now={at} connected={connected} refresh={() => {}} close={() => {}} diagnostics={() => {}} />)).document;

it("renders only host values, treats zero as measured and removes live bars from stale/disconnected readings", () => {
  const fresh = view(app);
  assert.equal(fresh.querySelector('.fy-system-metric .fy-system-value')?.textContent, "0%");
  assert.equal(fresh.querySelectorAll('.fy-system-metric .fy-system-meter').length, 2);
  assert(!fresh.toString().includes("Example data")); assert(!fresh.toString().includes("24%"));
  for (const old of [view(app, now + 20_000), view(app, now, false)]) {
    assert.equal(old.querySelector('.fy-system-metric .fy-system-value')?.textContent, "Last: 0%");
    assert.equal(old.querySelectorAll('.fy-system-metric .fy-system-meter').length, 0);
    assert(old.toString().includes("Unavailable"));
  }
  assert(view(app, now, false).querySelector('footer button')?.hasAttribute('disabled'));
});
it("groups destinations by measured volume without adding capacity, and uses the same storage finding as Diagnostics", () => {
  const root = { rootId: "a", role: "local-ai" as const, state: "measured" as const, source: "host-provided" as const, limitations: [], pressure: null, forecast: null,
    capacity: { volumeId: "volume", mappingRevision: "mount", measuredAt: now, availableBytes: 2 * gib, totalBytes: 500 * gib } };
  const storage = { ...app, storageHealth: { at: now, writing: false, roots: [root, { ...root, rootId: "b", role: "downloads" as const,
    capacity: { ...root.capacity, mappingRevision: "different-root-mapping", availableBytes: 7 * gib } }] } };
  const fresh = view(storage); assert.equal(fresh.querySelectorAll('.fy-system-drive').length, 1);
  assert(fresh.toString().includes('Storage is running low')); assert(fresh.toString().includes('2 GiB free'));
  assert(!fresh.toString().includes('Export waiting')); assert(!fresh.toString().includes('Another 3 GiB'));
  const stale = view(storage, now + 61_000); assert(!stale.toString().includes('Storage is running low'));
  assert(stale.toString().includes('Last: 2 GiB free')); assert.equal(stale.querySelectorAll('.fy-system-storage .fy-system-meter').length, 0);
  const partial = view({ ...storage, storageHealth: { ...storage.storageHealth, roots: [root, { ...root, rootId: 'b', state: 'unavailable' }] } });
  assert(partial.toString().includes('1 destination stale or unavailable'));
});

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Element: dom.Element, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom.document, 'activeElement', { value: null, writable: true, configurable: true });
dom.HTMLElement.prototype.focus = function () { Object.assign(dom.document, { activeElement: this }); };
Object.assign(dom.HTMLElement.prototype, { showModal(this: HTMLElement) { this.setAttribute('open', ''); }, show(this: HTMLElement) { this.setAttribute('open', ''); }, close(this: HTMLElement) { this.removeAttribute('open'); } });
Object.assign(dom.window, { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
function Location() { return <output id="location">{useLocation().pathname}</output>; }
it("opens the native modal via System, requests read-only refresh and navigates to existing Diagnostics with focus return", async () => {
  const sent: ClientMessage[] = [], container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  __setStateForTest({ ...FIXTURE_STATE, world: null, app }, { connection: 'open' });
  __setBridgeForTest({ appVersion: 'test', platform: 'test', connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  try {
    await act(async () => root.render(<MemoryRouter><AppChrome /><SystemPanel /><Location /></MemoryRouter>));
    const trigger = container.querySelector<HTMLButtonElement>('[data-system-trigger]')!;
    trigger.focus(); await act(async () => trigger.click());
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const dialog = document.querySelector<HTMLDialogElement>('.fy-system-host')!; assert(dialog.hasAttribute('open'));
    assert.equal(dialog.getAttribute('aria-label'), 'System'); assert.equal(sent.filter(row => row.kind === 'refresh-diagnostics').length, 1);
    await act(async () => dialog.querySelector<HTMLButtonElement>('footer button')!.click());
    assert.equal(sent.filter(row => row.kind === 'refresh-diagnostics').length, 2);
    assert.equal(sent.filter(row => row.kind === 'refresh-system-resources').length, 2); assert.equal(sent.length, 4, 'No provider, repair or approval commands');
    await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Close System"]')!.click());
    assert.equal(document.activeElement, trigger);
    await act(async () => trigger.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.fy-system-host footer button')].find(button => button.textContent === 'Diagnostics')!.click());
    assert.equal(container.querySelector('#location')?.textContent, '/settings/diagnostics');
    assert.equal(document.querySelector('.fy-system-host'), null);
  } finally { await act(async () => { closeSystemPanel(); root.unmount(); }); container.remove(); __setBridgeForTest(null); }
});
it("compares newly received samples with render time before the next age tick and focuses the warning's existing Diagnostics row", async () => {
  const oldNow = Date.now; let clock = 1_000_000; Date.now = () => clock;
  const sample = structuredClone(resources); sample.at = clock; sample.cpu.measuredAt = clock; sample.memory.measuredAt = clock;
  const state = { ...FIXTURE_STATE, app: { ...app, systemResources: sample, storageHealth: { at: clock, writing: false, roots: [
    { rootId: 'media', role: 'generated-media' as const, state: 'measured' as const, source: 'host-provided' as const, limitations: [], pressure: null, forecast: null,
      capacity: { volumeId: 'low-volume', mappingRevision: 'map', measuredAt: clock, availableBytes: 2 * gib, totalBytes: 500 * gib } },
  ] } } };
  const snapshot = deriveDiagnostics({ sources: diagnosticsSources(state.app), tails: { appLog: [] }, previous: null, now: new Date(clock).toISOString() });
  __setStateForTest(state, { diagnostics: snapshot });
  __setBridgeForTest({ appVersion: 'test', platform: 'test', connect() {}, subscribe() {}, send() {} });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><AppChrome /><SystemPanel /><Routes><Route path="/" element={null} /><Route path="/settings/diagnostics" element={<SettingsDiagnosticsScreen />} /></Routes></MemoryRouter>));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-system-trigger]')!.click());
    clock += 5; sample.cpu.measuredAt = clock; sample.memory.measuredAt = clock;
    await act(async () => __setStateForTest({ ...state, app: { ...state.app, systemResources: { ...sample } } }, { diagnostics: snapshot }));
    assert(!document.querySelector('.fy-system-metrics')?.textContent?.includes('Time unavailable'));
    assert.equal(document.querySelector('.fy-system-metric .fy-system-value')?.textContent, '0%');
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.fy-system-notice button')].find(button => button.textContent === 'Review in Diagnostics')!.click());
    assert.equal(document.activeElement?.id, 'diag-storage-pressure:low-volume');
  } finally { Date.now = oldNow; await act(async () => { closeSystemPanel(); root.unmount(); }); container.remove(); __setBridgeForTest(null); }
});
it("expires the closed System shortcut's storage warning without a store event or host probe", async t => {
  const clock = 1_000_000;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: clock });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const sent: ClientMessage[] = [];
  __setStateForTest({ ...FIXTURE_STATE, app: { ...app, storageHealth: { at: clock, writing: false, roots: [
    { rootId: 'media', role: 'generated-media', state: 'measured', source: 'host-provided', limitations: [], pressure: null, forecast: null,
      capacity: { volumeId: 'low-volume', mappingRevision: 'map', measuredAt: clock, availableBytes: 2 * gib, totalBytes: 500 * gib } },
  ] } } }, { connection: 'open' });
  __setBridgeForTest({ appVersion: 'test', platform: 'test', connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  try {
    await act(async () => root.render(<MemoryRouter><AppChrome /></MemoryRouter>));
    const trigger = container.querySelector<HTMLButtonElement>('[data-system-trigger]')!;
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert(trigger.querySelector('.fy-iconbtn__dot')); assert.equal(trigger.title, 'System — storage needs attention');
    await act(async () => t.mock.timers.tick(60_001));
    assert.equal(trigger.querySelector('.fy-iconbtn__dot'), null); assert.equal(trigger.title, 'System');
    assert.equal(sent.length, 0, 'Presentation expiry must not collect host resources or storage');
  } finally { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); t.mock.timers.reset(); }
});
