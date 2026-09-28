import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { REMOTE_HOST_ONLY_COMMANDS, type ClientMessage } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __connectionStatusForTest, __setBridgeForTest, __setStateForTest, send, subscribeRemoteRefusals } from "../src/lib/store.js";
import { __resetSettingsReturnForTest } from "../src/lib/settings-return.js";
import { __resetActivityPanelForTest, openActivityPanel } from "../src/lib/activity-panel.js";
import { settingsLayoutFixture } from "./settings-layout-fixture.js";
const dom = parseHTML('<html><head><meta name="arke-remote" content="true"></head><body></body></html>');
let width = 375;
Object.assign(dom.window, { innerWidth: width, innerHeight: 812, location: { origin: "https://studio.test" }, getComputedStyle: () => ({ direction: "ltr" }), matchMedia: (query: string) => ({ matches: !query.includes("hover: hover") && !query.includes("pointer: fine") && [...query.matchAll(/\((min|max)-width: (\d+)px\)/g)].every(([,kind,value]) => kind === "min" ? width >= Number(value) : width <= Number(value)), addEventListener() {}, removeEventListener() {} }) });
Object.assign(dom.HTMLElement.prototype, { showModal(this: HTMLElement) { this.setAttribute("open", ""); }, close(this: HTMLElement) { this.removeAttribute("open"); }, getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 44, bottom: 44, width: 44, height: 44 }), scrollIntoView() {} });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
const realFetch = globalThis.fetch;
let root: Root | null = null;
let sent: ClientMessage[] = [];
const find = (selector: string) => document.querySelector<HTMLElement>(selector)!;
async function click(selector: string) { assert.ok(find(selector), selector); await act(async () => find(selector).click()); }
async function mount(path = "/settings", pixels = 375) {
 width = pixels; sent = []; __resetSettingsReturnForTest(); __resetActivityPanelForTest();
 __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(raw) { sent.push(JSON.parse(raw)); } });
 __setStateForTest(settingsLayoutFixture()); __connectionStatusForTest("open");
 const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
 await act(async () => root!.render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>));
}
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; globalThis.fetch = realFetch; __resetActivityPanelForTest(); });
it("phone Settings opens on sections and preserves the section route through back and detail", async () => {
 await mount(); assert.equal(find("dialog h2").textContent, "Settings"); assert.ok(find(".fy-settings-sections"));
 await click('.fy-settings-sections a[href="/settings/providers"]'); assert.equal(find("dialog h2").textContent, "Providers");
 await click(".fy-provider-row .fy-src"); assert.ok(find(".fy-cols--detail")); assert.match(find(".fy-provider-detail").textContent!, /On your PC/);
 await click('dialog [aria-label="Back"]'); assert.equal(find(".fy-cols--detail"), null);
 await click('dialog [aria-label="Back"]'); assert.equal(find("dialog h2").textContent, "Settings");
});
it("a phone deep link opens General immediately and its defaults still send commands", async () => {
 await mount("/settings/general"); assert.equal(find("dialog h2").textContent, "General");
 const select = find('[aria-label="Model for Images"]') as HTMLSelectElement;
 const key = Object.keys(select).find(key => key.startsWith("__reactProps$"))!;
 const props = (select as unknown as Record<string, { onChange(event: unknown): void }>)[key]!;
 await act(async () => props.onChange({ target: { value: "flux-1.1" } }));
 assert.ok(sent.some(m => m.kind === "set-routing-default"));
});
it("paired browsers at desktop width get states, never host key and sign-in controls", async () => {
 await mount("/settings/providers?provider=fal", 1360);
 assert.match(find('[data-testid="provider-pane"]').textContent!, /Keyset/);
 assert.match(find('[data-testid="provider-pane"]').textContent!, /On your PC/);
 assert.equal(find('input[type="password"]'), null); assert.doesNotMatch(document.body.textContent!, /NEVER-RENDER/);
});
it("remote command guard refuses every named host command without emitting it and allows defaults", async () => {
 await mount(); const refused: string[] = []; const off = subscribeRemoteRefusals(r => refused.push(r.command));
 const before = sent.length;
 for (const kind of REMOTE_HOST_ONLY_COMMANDS) assert.equal(send({ kind } as ClientMessage), false);
 off(); assert.equal(sent.length, before); assert.deepEqual(refused, [...REMOTE_HOST_ONLY_COMMANDS]);
 assert.equal(send({ kind: "set-model-enabled", modelId: "flux-1.1", enabled: true }), true);
 assert.equal(sent.at(-1)?.kind, "set-model-enabled");
});
it("remote access renders only the authenticated device facts and its notification control", async () => {
 globalThis.fetch = async () => new Response(JSON.stringify({ name: "Chrome on Android", pairedAt: 1, expiresAt: null }), { headers: { "Content-Type": "application/json" } });
 await mount("/settings/remote-access");
 assert.match(document.body.textContent!, /Chrome on Android/); assert.match(document.body.textContent!, /never expires/);
 assert.ok(find('[aria-label="Notify this phone"]')); assert.doesNotMatch(document.body.textContent!, /Revoke|Approve|Pair a device/);
});
it("remote Account is a phone sheet with PC sign-in state and no sign-out command", async () => {
 const state = settingsLayoutFixture(); await mount('/w/' + state.world!.meta.worldId);
 await click('[data-account-control]'); assert.ok(find('.fy-account-phone[open]'));
 assert.match(find('.fy-account-phone').textContent!, /Helen Marsh/); assert.match(find('.fy-account-phone').textContent!, /On your PC/);
 assert.equal([...document.querySelectorAll('button')].filter(e => e.textContent === "Sign out").length, 0);
});
it("a coarse outside scroll leaves Fold Activity open; a subsequent outside tap closes it", async () => {
 const state = settingsLayoutFixture(); await mount('/w/' + state.world!.meta.worldId, 984);
 await act(async () => openActivityPanel("inbox")); assert.ok(find('.fy-ap'));
 const pointer = (type: string, x = 10, y = 10) => { const event = new Event(type, { bubbles: true }); Object.assign(event, { pointerId: 1, clientX: x, clientY: y }); document.body.dispatchEvent(event); };
 await act(async () => { pointer('pointerdown'); }); assert.ok(find('.fy-ap'));
 await act(async () => { pointer('pointermove', 10, 30); window.dispatchEvent(new Event('scroll')); pointer('pointerup', 10, 30); }); assert.ok(find('.fy-ap'));
 await act(async () => { pointer('pointerdown'); pointer('pointerup'); }); assert.equal(find('.fy-ap'), null);
});
it("notifications belong to this browser and never change the PC preference", async () => {
 const originals = new Map(["Notification", "navigator", "localStorage"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
 const values = new Map<string, string>(); let permissionRequests = 0; let registrations = 0;
 const notification = { permission: "default", async requestPermission() { permissionRequests++; this.permission = "granted"; return "granted"; } };
 try {
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: notification });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: { async register(path: string) { assert.equal(path, "/notification-worker.js"); registrations++; }, addEventListener() {}, removeEventListener() {} } } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  await mount("/settings/notifications");
  assert.equal(permissionRequests, 0);
  await click('[aria-label="Notify this phone"]');
  assert.equal(find('[aria-label="Notify this phone"]').getAttribute("aria-checked"), "true");
  assert.equal(values.get("arke-device-notifications"), "on");
  await click('[aria-label="Notify this phone"]');
  assert.equal(values.get("arke-device-notifications"), "off");
  assert.equal(permissionRequests, 1); assert.equal(registrations, 1);
  assert.ok(sent.every(command => command.kind !== "set-background-notifications"));
 } finally {
  await act(async () => root?.unmount()); root = null;
  for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
 }
});
it("a provider without a key stays off and AI models renders its remedy as a PC state", async () => {
 await mount("/settings/providers");
 const state = settingsLayoutFixture(); state.app.providers = state.app.providers.map(p => p.id === "fal" ? { ...p, configured: false, validation: "untested", probes: [] } : p);
 await act(async () => __setStateForTest(state));
 assert.equal(find('[aria-label="FAL models"]').getAttribute("aria-checked"), "false");
 await click('dialog [aria-label="Back"]'); await click('.fy-settings-sections a[href="/settings/models"]');
 assert.match(document.body.textContent!, /On your PC/);
 assert.equal([...document.querySelectorAll('button')].some(e => /^(Add a key|Replace key|Sign in again)$/.test(e.textContent!)), false);
});
