import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { REMOTE_HOST_ONLY_COMMANDS, type ClientMessage } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __connectionStatusForTest, __setBridgeForTest, __setStateForTest, __stateForTest, __pendingQueueRequestsForTest, pickManuscript, stageVoiceClip, uploadWorldImage, uploadMasterLook, pickStagedReference, send, subscribeRemoteRefusals } from "../src/lib/store.js";
import { __resetSettingsReturnForTest } from "../src/lib/settings-return.js";
import { __resetActivityPanelForTest, openActivityPanel, inspectProviderCalls, leaveProviderCalls } from "../src/lib/activity-panel.js";
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
it("component deep links go back to the Providers list and a phone can reset its narrator", async () => {
 await mount("/settings/providers?component=voxa");
 await click('dialog [aria-label="Back"]');
 assert.equal(find("dialog h2").textContent, "Providers"); assert.equal(find(".fy-cols--detail"), null);
 await click('dialog [aria-label="Back"]'); await click('.fy-settings-sections a[href="/settings/general"]');
 const state = settingsLayoutFixture(); state.app.narrator = { provider: "kokoro", model: "kokoro-82m", voiceId: "bf_emma", label: "Emma" };
 await act(async () => __setStateForTest(state));
 // The row's value is the phone's Change; Reset sits beside it and takes a second press, so one
 // stray tap cannot clear a chosen narrator.
 assert.ok(find('[data-testid="narrator-change"]'), "a phone can change its narrator");
 const before = sent.length;
 await click('[data-testid="narrator-reset"]');
 assert.equal(sent.length, before, "one tap only asks");
 assert.match(find('[data-testid="narrator-reset"]').textContent!, /Reset to George\?/);
 await click('[data-testid="narrator-reset"]');
 assert.deepEqual(sent.at(-1), { kind: "set-narrator", voice: null });
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
  // A browser permission reset must not make the next enable press silently turn it off.
  notification.permission = "default";
  await click('[aria-label="Notify this phone"]');
  assert.equal(values.get("arke-device-notifications"), "on");
  await click('[aria-label="Notify this phone"]');
  assert.equal(values.get("arke-device-notifications"), "off");
  assert.equal(permissionRequests, 2); assert.equal(registrations, 2);
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
it("phone pane and provider navigation starts at the top and focuses the heading", async () => {
 await mount(); const body = find('.fy-page-sheet__body'), heading = find('dialog h2'); let focus = 0;
 heading.focus = () => { focus++; }; body.scrollTop = 400;
 await click('.fy-settings-sections a[href="/settings/providers"]');
 assert.equal(body.scrollTop, 0); assert.equal(focus, 1);
 body.scrollTop = 250; await click('.fy-provider-row .fy-src');
 assert.equal(body.scrollTop, 0); assert.equal(focus, 2);
});
it("Activity call-detail navigation resets its inner scroller and focuses Back", async () => {
 await mount(); await act(async () => openActivityPanel("inbox"));
 const body = find('.fy-ap__body'); body.scrollTop = 500;
 const original = dom.HTMLElement.prototype.focus; const focused: HTMLElement[] = [];
 dom.HTMLElement.prototype.focus = function(this: HTMLElement) { focused.push(this); };
 try {
  await act(async () => inspectProviderCalls(null));
  assert.equal(body.scrollTop, 0); assert.equal(focused.at(-1), find('.fy-activity-phone header [aria-label="Back"]'));
  body.scrollTop = 300; await act(async () => leaveProviderCalls());
  assert.equal(body.scrollTop, 0); assert.equal(focused.at(-1), find('.fy-activity-phone h2'));
 } finally { dom.HTMLElement.prototype.focus = original; }
});
it("Activity tabs keep focus on the tab and world scope belongs only to Inbox and Spend", async () => {
 for (const pixels of [375, 984]) {
  await mount(undefined, pixels); await act(async () => openActivityPanel("inbox"));
  const original = dom.HTMLElement.prototype.focus; const focused: HTMLElement[] = [];
  dom.HTMLElement.prototype.focus = function(this: HTMLElement) { focused.push(this); };
  try {
   for (const tab of ["new", "spend", "inbox"] as const) {
    const button = [...document.querySelectorAll<HTMLElement>('.fy-ap [role="tab"]')].find(e => e.textContent?.startsWith(tab === "new" ? "What's new" : tab === "spend" ? "Spend" : "Inbox"))!;
    assert.ok(button); button.focus(); const before = focused.length; find('.fy-ap__body').scrollTop = 400;
    await act(async () => button.click());
    assert.equal(focused.length, before); assert.equal(focused.at(-1), button); assert.equal(button.getAttribute("aria-selected"), "true");
    assert.equal(find('.fy-ap__body').scrollTop, 0);
    assert.equal(!!find(pixels < 600 ? '.fy-activity-phone footer' : '.fy-ap__scope'), tab !== "new");
   }
  } finally { dom.HTMLElement.prototype.focus = original; }
  await act(async () => root?.unmount()); root = null; document.body.innerHTML = "";
 }
});
it("a provider is off when only locked models remain enabled", async () => {
 await mount('/settings/providers'); const state = settingsLayoutFixture();
 state.app.providers = state.app.providers.map(p => p.id === "fal" ? { ...p, probes: [{ capability: "image", available: true }, { capability: "video", available: false }, { capability: "music", available: false }] } : p);
 state.app.models.disabled = ["nano-banana-pro", "flux-1.1"];
 await act(async () => __setStateForTest(state));
 const control = find('[aria-label="FAL models"]');
 assert.equal(control.getAttribute('aria-checked'), 'false'); assert.equal(control.hasAttribute('disabled'), false);
 await click('[aria-label="FAL models"]');
 assert.ok(sent.some(command => command.kind === 'set-model-enabled' && command.modelId === 'nano-banana-pro' && command.enabled));
 const changed = structuredClone(state); changed.app.models.disabled = ["flux-1.1"];
 await act(async () => __setStateForTest(changed)); assert.equal(control.getAttribute('aria-checked'), 'true');
});
it("a refused manuscript picker reaches a terminal state without a phantom in-flight import", async () => {
 await mount(); const world = settingsLayoutFixture().world!; let request = "";
 await act(async () => { request = pickManuscript(world.meta.worldId, world.productions[0]!.meta.id); });
 assert.equal(__stateForTest().manuscripts[request]?.state, "refused");
 assert.match(__stateForTest().manuscripts[request]?.reason ?? "", /on your PC/);
 assert.ok(!sent.some(command => command.kind === "pick-manuscript"));
 assert.equal(stageVoiceClip(world.meta.worldId), null);
 const pending = __pendingQueueRequestsForTest();
 uploadWorldImage(world.meta.worldId); uploadMasterLook(world.meta.worldId); pickStagedReference(world.meta.worldId, "world-image");
 assert.deepEqual(__pendingQueueRequestsForTest(), pending, "refused pickers do not leave orphan queue requests");
 assert.equal(typeof stageVoiceClip(world.meta.worldId, { audioBase64: "UklGRg==", contentType: "audio/wav" }), "string", "browser recordings remain available");
});
it("compact local provider switches remain off when the capability is unavailable", async () => {
 const marker = document.querySelector('meta[name="arke-remote"]')!; marker.setAttribute('content', 'false');
 try {
  await mount('/settings/providers?provider=fal', 984);
  const state = settingsLayoutFixture(); state.app.providers = state.app.providers.map(p => p.id === "fal" ? { ...p, configured: false, validation: "untested", probes: [] } : p);
  await act(async () => __setStateForTest(state));
  const switches = [...document.querySelectorAll('[data-testid="provider-pane"] [role="switch"]')];
  assert.ok(switches.length > 0); assert.ok(switches.every(button => button.getAttribute('aria-checked') === 'false' && !button.classList.contains('is-on')));
 } finally { marker.setAttribute('content', 'true'); }
});
it("ready notifications wait for local finalization and still support jobs without finalization", async () => {
 const originals = new Map(["Notification", "navigator", "localStorage"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
 const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState"); const shown: string[] = [];
 try {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: { permission: "granted" } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: { async getRegistration() { return { async showNotification(_title: string, options: { tag: string }) { shown.push(options.tag); } }; }, addEventListener() {}, removeEventListener() {} } } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "on" } });
  await mount(); const state = settingsLayoutFixture(), job = state.app.jobs.find(j => j.status === "running")!; assert.ok(job);
  job.status = "succeeded"; job.finalization = { status: "pending", error: null, updatedAt: job.updatedAt };
  await act(async () => { __setStateForTest(state); await Promise.resolve(); });
  assert.equal(shown.filter(tag => tag.startsWith("ready:")).length, 0);
  const failed = structuredClone(state); failed.app.jobs.find(j => j.id === job.id)!.finalization = { status: "failed", error: "could not file the result", updatedAt: job.updatedAt };
  await act(async () => { __setStateForTest(failed); await Promise.resolve(); });
  assert.equal(shown.filter(tag => tag.startsWith("ready:")).length, 0);
  const done = structuredClone(state); done.app.jobs.find(j => j.id === job.id)!.finalization = { status: "complete", error: null, updatedAt: job.updatedAt };
  await act(async () => { __setStateForTest(done); await Promise.resolve(); });
  assert.deepEqual(shown.filter(tag => tag.startsWith("ready:")), [`ready:${job.id}`]);
  const next = structuredClone(done), legacy = structuredClone(job); legacy.id = job.id.slice(0, -1) + "7"; delete legacy.finalization; next.app.jobs.push(legacy);
  await act(async () => { __setStateForTest(next); await Promise.resolve(); });
  assert.deepEqual(shown.filter(tag => tag.startsWith("ready:")), [`ready:${job.id}`, `ready:${legacy.id}`]);
 } finally {
  await act(async () => root?.unmount()); root = null;
  for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  if (visibility) Object.defineProperty(document, "visibilityState", visibility); else Reflect.deleteProperty(document, "visibilityState");
 }
});
it("an outstanding decision only notifies once when its diagnostic detail changes", async () => {
 const originals = new Map(["Notification", "navigator", "localStorage"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
 const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState"); const shown: string[] = [];
 try {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: { permission: "granted" } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: { async getRegistration() { return { async showNotification(_title: string, options: { tag: string }) { shown.push(options.tag); } }; }, addEventListener() {}, removeEventListener() {} } } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "on" } });
  await mount(); const state = settingsLayoutFixture();
  const job = state.app.jobs.find(job => job.status === "running")!; assert.ok(job);
  job.status = "needs-reconciliation"; job.error = "connection lost";
  await act(async () => { __setStateForTest(state); await Promise.resolve(); });
  assert.equal(shown.length, 1);
  const changed = structuredClone(state); changed.app.jobs.find(j => j.id === job.id)!.error = "outcome still unknown";
  await act(async () => { __setStateForTest(changed); await Promise.resolve(); });
  assert.equal(shown.length, 1);
 } finally {
  await act(async () => root?.unmount()); root = null;
  for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  if (visibility) Object.defineProperty(document, "visibilityState", visibility); else Reflect.deleteProperty(document, "visibilityState");
 }
});
