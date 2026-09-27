import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import type { RemoteAccessCommand, RemoteAccessStatus } from "@arke-studio/contracts";
import { SettingsRemoteAccessScreen } from "../src/screens/settings-remote-access.js";
import { RemoteEntry } from "../src/components/remote-entry.js";
import { isRemoteSession, remoteSocketUrl } from "../src/lib/remote-session.js";
import { mediaUrl } from "../src/lib/media.js";
import { devSession } from "../src/lib/dev-session.js";
import { __setBridgeForTest } from "../src/lib/store.js";

const dom = parseHTML('<html><head><meta name="arke-remote" content="true"></head><body></body></html>');
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement,
  Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(window, "location", { configurable: true, value: { origin: "https://studio.example.ts.net" } });
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const status: RemoteAccessStatus = { enabled: true, running: true, startOnLogin: false, startupSupported: true,
  pairingDuration: 90,
  url: "https://studio.example.ts.net", reason: null, devices: [], pending: [{ id: "request", name: "Phone", expiresAt: Date.now() + 10000 }] };

it("hosted media and sockets use the clean page origin without exposing a process credential", () => {
  delete window.arke;
  assert.equal(isRemoteSession(), true);
  assert.equal(remoteSocketUrl(), "wss://studio.example.ts.net/");
  assert.equal(mediaUrl("world", "art.png"), "https://studio.example.ts.net/media/world/art.png");
  assert.equal(devSession(), null);
});
it("only the desktop exposes owner pairing and revocation controls", async () => {
  const calls: RemoteAccessCommand[] = [];
  window.arke = { remoteAccess: async command => {
    calls.push(command);
    return { status, ...(command.kind === "pair" ? { pairing: { code: "ABCDEFGH", expiresAt: Date.now() + 300000 } } : {}) };
  } } as typeof window.arke;
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  try {
    await act(async () => { root.render(<SettingsRemoteAccessScreen />); await flush(); });
    const buttons = () => [...element.querySelectorAll("button")];
    await act(async () => { buttons().find(button => button.textContent === "Pair a device")!.click(); await flush(); });
    assert.ok(element.textContent?.includes("ABCDEFGH"));
    await act(async () => { buttons().find(button => button.textContent === "Approve Phone")!.click(); await flush(); });
    assert.ok(calls.some(command => command.kind === "approve" && command.id === "request"));
    assert.equal(element.querySelector("a")?.href, status.url);
  } finally { await act(async () => root.unmount()); element.remove(); delete window.arke; }
  const browser = document.createElement("div"); document.body.append(browser); const browserRoot = createRoot(browser);
  try {
    await act(async () => browserRoot.render(<SettingsRemoteAccessScreen />));
    assert.equal(browser.querySelectorAll("button").length, 0);
    assert.ok(browser.textContent?.includes("on your PC"));
  } finally { await act(async () => browserRoot.unmount()); browser.remove(); }
});
it("desktop duration offers all four choices, uses saved replies and labels Never devices", async () => {
  const calls: RemoteAccessCommand[] = [];
  let current: RemoteAccessStatus = { ...status, running: false, enabled: false,
    devices: [{ id: "paired", name: "My phone", createdAt: Date.now(), expiresAt: null }] };
  window.arke = { remoteAccess: async command => {
    calls.push(command);
    if (command.kind === "duration") current = { ...current, pairingDuration: command.duration };
    return { status: current };
  } } as typeof window.arke;
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  try {
    await act(async () => { root.render(<SettingsRemoteAccessScreen />); await flush(); });
    const select = element.querySelector("select")!;
    assert.equal(select.disabled, false, "preference can change while remote access is off");
    assert.equal(select.value, "90");
    assert.deepEqual([...select.options].map(option => [option.value, option.textContent]),
      [["30", "30 days"], ["90", "90 days"], ["120", "120 days"], ["never", "Never"]]);
    for (const value of ["30", "120", "never", "90"]) {
      await act(async () => {
        select.querySelector<HTMLOptionElement>(`option[value="${value}"]`)!.selected = true;
        select.dispatchEvent(new Event("change", { bubbles: true })); await flush();
      });
      assert.deepEqual(calls.at(-1), { kind: "duration", duration: value === "never" ? "never" : Number(value) });
      assert.equal(select.value, value);
    }
    assert.ok(element.textContent?.includes("My phone · Never expires"));
    assert.ok(element.textContent?.includes("Existing devices keep their current expiry"));
  } finally { await act(async () => root.unmount()); element.remove(); delete window.arke; }
});
it("desktop shares a local QR and copies through its bridge, showing success only after a successful write", async () => {
  const calls: RemoteAccessCommand[] = []; let fail = false;
  let current = { ...status };
  window.arke = { remoteAccess: async command => {
    calls.push(command);
    if (command.kind === "disable") current = { ...current, running: false, enabled: false, url: null };
    if (command.kind === "copy-link" && fail) return { status: { ...current, reason: "Clipboard busy" } };
    return { status: current, ...(command.kind === "copy-link" ? { copied: true } : {}) };
  } } as typeof window.arke;
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  try {
    await act(async () => { root.render(<SettingsRemoteAccessScreen />); await flush(); });
    assert.ok(element.querySelector('svg[aria-label="Scan to open Studio on your phone"] path'));
    assert.equal(element.querySelectorAll("img").length, 0, "QR rendering uses no external image service");
    const buttons = () => [...element.querySelectorAll("button")];
    const copy = () => buttons().find(button => button.textContent === "Copy link")!.click();
    await act(async () => { copy(); await flush(); });
    assert.deepEqual(calls.at(-1), { kind: "copy-link" });
    assert.ok(element.textContent?.includes("Link copied"));
    fail = true;
    await act(async () => { copy(); await flush(); });
    assert.equal(element.textContent?.includes("Link copied"), false);
    assert.equal(element.querySelector('[role="alert"]')?.textContent, "Clipboard busy");
    await act(async () => { buttons().find(button => button.textContent === "Disable remote access")!.click(); await flush(); });
    assert.equal(element.querySelector('svg[role="img"]'), null);
    assert.equal(buttons().some(button => button.textContent === "Copy link"), false);
  } finally { await act(async () => root.unmount()); element.remove(); delete window.arke; }
});
it("an unpaired browser sees pairing, not Studio content; a remembered browser opens Studio", async () => {
  const previous = globalThis.fetch;
  __setBridgeForTest({ appVersion: "test", platform: "win32", connect() {}, send() {}, subscribe() {} });
  for (const authenticated of [false, true]) {
    globalThis.fetch = async input => new Response(null, { status: String(input) === "/remote/session" ? authenticated ? 204 : 401 : 410 });
    const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
    try {
      await act(async () => { root.render(<MemoryRouter><RemoteEntry><div>Private world</div></RemoteEntry></MemoryRouter>); await flush(); });
      assert.equal(element.textContent?.includes("Private world"), authenticated);
      assert.equal(!!element.querySelector("form"), !authenticated);
    } finally { await act(async () => root.unmount()); element.remove(); }
  }
  globalThis.fetch = previous;
});
