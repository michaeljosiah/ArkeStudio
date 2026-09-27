import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
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
it("an unpaired browser sees pairing, not Studio content; a remembered browser opens Studio", async () => {
  const previous = globalThis.fetch;
  __setBridgeForTest({ appVersion: "test", platform: "win32", connect() {}, send() {}, subscribe() {} });
  for (const authenticated of [false, true]) {
    globalThis.fetch = async input => new Response(null, { status: String(input) === "/remote/session" ? authenticated ? 204 : 401 : 410 });
    const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
    try {
      await act(async () => { root.render(<RemoteEntry><div>Private world</div></RemoteEntry>); await flush(); });
      assert.equal(element.textContent?.includes("Private world"), authenticated);
      assert.equal(!!element.querySelector("form"), !authenticated);
    } finally { await act(async () => root.unmount()); element.remove(); }
  }
  globalThis.fetch = previous;
});
