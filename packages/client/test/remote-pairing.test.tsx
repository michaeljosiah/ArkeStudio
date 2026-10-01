import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { parseHTML } from "linkedom";
import type { RemoteAccessCommand, RemoteAccessStatus } from "@arke-studio/contracts";
import { RemoteEntry, formatPairingCode } from "../src/components/remote-entry.js";
import { PairingPrompt } from "../src/components/pairing-prompt.js";
import { __setBridgeForTest } from "../src/lib/store.js";
import { prepareTestRemoteBrowser } from "./remote-browser.js";

/**
 * Pairing a phone on the launch surface, and the PC asked where you are (design turn 158i/j).
 */

const dom = parseHTML('<html><head><meta name="arke-remote" content="true"></head><body></body></html>');
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement,
  Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(window, "location", { configurable: true, value: { origin: "https://michael-desktop.tail1234.ts.net", hostname: "michael-desktop.tail1234.ts.net" } });
__setBridgeForTest({ appVersion: "test", platform: "win32", connect() {}, send() {}, subscribe() {} });
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const previousFetch = globalThis.fetch;
await prepareTestRemoteBrowser();
afterEach(() => { globalThis.fetch = previousFetch; delete window.arke; });

let where = "";
function Where() { where = useLocation().pathname; return null; }

async function mount(node: React.ReactNode, path = "/") {
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  await act(async () => { root.render(<MemoryRouter initialEntries={[path]}>{node}<Where /></MemoryRouter>); await flush(); });
  return { element, unmount: async () => { await act(async () => root.unmount()); element.remove(); } };
}

it("formats the code as it is typed, the way the gateway reads it", () => {
  assert.equal(formatPairingCode("7kq4m2xp"), "7KQ4-M2XP");
  assert.equal(formatPairingCode("7KQ4 - M2"), "7KQ4-M2");
  assert.equal(formatPairingCode("7kq"), "7KQ");
  assert.equal(formatPairingCode("7KQ4-M2XP-EXTRA"), "7KQ4-M2XP");
});

it("pairs on the launch surface, waits for the PC, and goes straight in once approved", async () => {
  let pairState = 410;
  let posted: unknown = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/remote/session") return new Response(null, { status: 401 });
    if (url === "/remote/pair" && init?.method === "POST") { posted = JSON.parse(String(init.body)); pairState = 202; return new Response(null, { status: 202 }); }
    return new Response(null, { status: pairState });
  }) as typeof fetch;
  const { element, unmount } = await mount(<RemoteEntry><div>Private world</div></RemoteEntry>);
  try {
    assert.ok(element.querySelector('[data-screen="startup"]'), "pairing is drawn on the launch surface");
    assert.ok(element.textContent?.includes("Pair this device"));
    assert.ok(element.textContent?.includes("michael-desktop"), "the way names the studio it pairs with");
    assert.ok(element.querySelector(".fy-launch--compact"), "the band steps down while pairing");
    assert.ok(!element.textContent?.includes("Private world"));

    const input = element.querySelector<HTMLInputElement>(".fy-launch__code")!;
    // linkedom keeps React's attribute casing; a browser folds it.
    assert.equal(input.getAttribute("autocomplete") ?? input.getAttribute("autoComplete"), "one-time-code");
    const submit = [...element.querySelectorAll("button")].find(b => b.textContent === "Request pairing")!;
    assert.ok(submit.disabled, "nothing to send until the code is whole");
    assert.equal(element.querySelector(".fy-launch__code-rest")?.textContent, "XXXX-XXXX");

    const form = element.querySelector("form")!;
    // As the other screens' tests type: set the value, then hand React's own onChange the event,
    // since linkedom's input events do not reach React's value tracker.
    await act(async () => {
      input.value = "7kq4m2";
      const key = Object.keys(input).find((candidate) => candidate.startsWith("__reactProps$"))!;
      (input as unknown as Record<string, { onChange(event: { target: HTMLInputElement }): void }>)[key]!.onChange({ target: input });
      await flush();
    });
    assert.equal(input.value, "7KQ4-M2");
    assert.equal(element.querySelector(".fy-launch__code-rest")?.textContent, "XX", "unfinished slots remain visible as in 158i");
    assert.ok(submit.disabled);
    await act(async () => {
      input.value = "7kq4m2xp";
      const key = Object.keys(input).find((candidate) => candidate.startsWith("__reactProps$"))!;
      (input as unknown as Record<string, { onChange(event: { target: HTMLInputElement }): void }>)[key]!.onChange({ target: input });
      await flush();
    });
    assert.equal(element.querySelector(".fy-launch__code-rest")?.textContent, "");
    await act(async () => { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await flush(); });
    assert.deepEqual(posted, { code: "7KQ4-M2XP", name: "My phone" });
    assert.ok(element.textContent?.includes("Waiting for your PC"));
    assert.ok(element.textContent?.includes("Approve My phone there."));

    // The PC approves; the next check lets the app in, pressed, so it goes on by itself.
    pairState = 204;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 3100)); await flush(); });
    assert.ok(element.textContent?.includes("Private world"));
    assert.equal(where, "/starting", "straight in, this once");
  } finally { await unmount(); }
});

it("says a refusal on the way, and the phone can try again", async () => {
  let pairState = 202;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/remote/session") return new Response(null, { status: 401 });
    if (init?.method === "POST") return new Response(null, { status: 429 });
    return new Response(null, { status: pairState });
  }) as typeof fetch;
  const { element, unmount } = await mount(<RemoteEntry><div>Private world</div></RemoteEntry>);
  try {
    assert.ok(element.textContent?.includes("Waiting for your PC"), "a reload mid-request keeps waiting");
    pairState = 410;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 3100)); await flush(); });
    assert.ok(element.querySelector("form"), "a request that ran out returns to the field");
    assert.ok(element.textContent?.includes("Not approved"), "a reloaded request still explains its refusal");
  } finally { await unmount(); }

  globalThis.fetch = (async () => { throw new TypeError("offline"); }) as typeof fetch;
  const offline = await mount(<RemoteEntry><div>Private world</div></RemoteEntry>);
  try {
    assert.ok(offline.element.textContent?.includes("Not answering"));
    assert.ok([...offline.element.querySelectorAll("button")].some(b => b.textContent === "Try again"));
  } finally { await offline.unmount(); }
});

it("recovers from a stalled session probe without refreshing the page", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let checks = 0;
  globalThis.fetch = (async (_input, init) => {
    if (++checks > 1) return new Response(null, { status: 204 });
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
  }) as typeof fetch;
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => { root.render(<MemoryRouter><RemoteEntry><div>Private world</div></RemoteEntry></MemoryRouter>); });
    assert.ok(element.textContent?.includes("Checking"));
    await act(async () => { t.mock.timers.tick(10_000); });
    assert.ok(element.textContent?.includes("Not answering"));
    assert.ok(element.textContent?.includes("Retrying automatically"));
    assert.ok(!element.textContent?.includes("Browser storage is needed"));
    await act(async () => { window.dispatchEvent(new window.Event("online")); });
    assert.equal(checks, 2);
    assert.ok(element.textContent?.includes("Private world"));
  } finally { await act(async () => root.unmount()); element.remove(); }
});

it("once in, a failed check keeps the app; only a revocation takes it out", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let answer: "in" | "gone" | "error" | "revoked" = "in";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (answer === "gone") throw new TypeError("Failed to fetch");
    if (answer === "error") return new Response(null, { status: 502 });
    if (answer === "in") return new Response(null, { status: 204 });
    return new Response(null, { status: String(input) === "/remote/session" ? 401 : 410 });
  }) as typeof fetch;
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => { root.render(<MemoryRouter><RemoteEntry><div>Private world</div></RemoteEntry></MemoryRouter>); });
    assert.ok(element.textContent?.includes("Private world"));
    // Folding the phone hides and shows the page; the check on its return meets no network.
    answer = "gone";
    await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
    await act(async () => { t.mock.timers.tick(3000); });
    assert.ok(element.textContent?.includes("Private world"), "a check that cannot reach the studio leaves the app up");
    assert.ok(!element.textContent?.includes("Not answering"));
    answer = "error";
    await act(async () => { t.mock.timers.tick(3000); });
    assert.ok(element.textContent?.includes("Private world"), "nor does a proxy error");
    answer = "revoked";
    await act(async () => { t.mock.timers.tick(3000); });
    assert.ok(element.textContent?.includes("Pair this device"), "a revoked device is taken back to pairing");
    assert.ok(!element.textContent?.includes("Private world"));
  } finally { await act(async () => root.unmount()); element.remove(); }
});

it("keeps a one-use pairing submission alive beyond the session probe deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let submitted: RequestInit | undefined;
  let accept: ((response: Response) => void) | undefined;
  globalThis.fetch = (async (input, init) => {
    if (init?.method === "POST") {
      submitted = init;
      return new Promise<Response>(resolve => { accept = resolve; });
    }
    return new Response(null, { status: String(input) === "/remote/session" ? 401 : 410 });
  }) as typeof fetch;
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => { root.render(<MemoryRouter><RemoteEntry><div>Private world</div></RemoteEntry></MemoryRouter>); });
    const input = element.querySelector<HTMLInputElement>(".fy-launch__code")!;
    await act(async () => {
      input.value = "7KQ4M2XP";
      const key = Object.keys(input).find(candidate => candidate.startsWith("__reactProps$"))!;
      (input as unknown as Record<string, { onChange(event: { target: HTMLInputElement }): void }>)[key]!.onChange({ target: input });
    });
    await act(async () => { element.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    assert.ok(submitted);
    await act(async () => { t.mock.timers.tick(15_000); });
    assert.ok(!submitted.signal?.aborted, "the one-use request keeps waiting for its cookie response");
    await act(async () => { accept!(new Response(null, { status: 202 })); });
    assert.ok(element.textContent?.includes("Waiting for your PC"));
  } finally { await act(async () => root.unmount()); element.remove(); }
});

it("goes straight in after a pending request survives a reload", async () => {
  let pairing = 202;
  globalThis.fetch = (async (input: RequestInfo | URL) => new Response(null, {
    status: String(input) === "/remote/session" ? 401 : pairing,
  })) as typeof fetch;
  const { element, unmount } = await mount(<RemoteEntry><div>Private world</div></RemoteEntry>);
  try {
    assert.ok(element.textContent?.includes("Waiting for your PC"));
    pairing = 204;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 3100)); await flush(); });
    assert.equal(where, "/starting");
    assert.ok(element.textContent?.includes("Private world"));
  } finally { await unmount(); }
});

it("does not let an older pairing check replace a newly submitted request", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let reads = 0;
  let release: ((response: Response) => void) | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/remote/session") return new Response(null, { status: 401 });
    if (init?.method === "POST") return new Response(null, { status: 202 });
    if (++reads === 1) return new Response(null, { status: 410 });
    return new Promise<Response>(resolve => { release = resolve; });
  }) as typeof fetch;
  const { element, unmount } = await mount(<RemoteEntry><div>Private world</div></RemoteEntry>);
  try {
    await act(async () => { t.mock.timers.tick(3000); await flush(); });
    assert.ok(release, "a pre-submission check is awaiting its response");
    const input = element.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      input.value = "7KQ4-M2XP";
      const key = Object.keys(input).find(candidate => candidate.startsWith("__reactProps$"))!;
      (input as unknown as Record<string, { onChange(event: { target: HTMLInputElement }): void }>)[key]!.onChange({ target: input });
      await flush();
    });
    await act(async () => { element.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await flush(); });
    assert.ok(element.textContent?.includes("Waiting for your PC"));
    await act(async () => { release!(new Response(null, { status: 410 })); await flush(); });
    assert.ok(element.textContent?.includes("Waiting for your PC"), "the old 410 cannot undo the successful POST");
  } finally { await unmount(); }
});

let duration: RemoteAccessStatus["pairingDuration"] = 90;
const status = (pending: RemoteAccessStatus["pending"]): RemoteAccessStatus => ({ enabled: true, running: true,
  startOnLogin: false, startupSupported: true, pairingDuration: duration, url: "https://michael-desktop.tail1234.ts.net",
  reason: null, devices: [], pending });

it("asks the PC over whatever it shows, and the close means later", async () => {
  const calls: RemoteAccessCommand[] = [];
  let pending = [{ id: "3f1c6a2e-8b1d-4c5e-9f0a-1b2c3d4e5f60", name: "Pixel 9", expiresAt: Date.now() + 250_000 }];
  window.arke = { remoteAccess: async (command: RemoteAccessCommand) => {
    calls.push(command);
    if (command.kind === "approve" || command.kind === "reject") pending = [];
    return { status: status(pending) };
  } } as unknown as typeof window.arke;

  const onSettings = await mount(<PairingPrompt />, "/settings/remote-access");
  try { assert.ok(!document.body.textContent?.includes("Pair Pixel 9?"), "not while the list is on screen"); }
  finally { await onSettings.unmount(); }

  const { unmount } = await mount(<PairingPrompt />, "/w/some-world");
  try {
    assert.ok(document.body.textContent?.includes("Pair Pixel 9?"));
    assert.ok(document.body.textContent?.includes("Full access to this studio for 90 days."));
    const approve = [...document.body.querySelectorAll("button")].find(b => b.textContent === "Approve")!;
    await act(async () => { approve.click(); await flush(); });
    assert.ok(calls.some(c => c.kind === "approve" && c.id === "3f1c6a2e-8b1d-4c5e-9f0a-1b2c3d4e5f60"));
    assert.ok(!document.body.textContent?.includes("Pair Pixel 9?"), "gone once decided");
  } finally { await unmount(); }

  pending = [{ id: "7a1c6a2e-8b1d-4c5e-9f0a-1b2c3d4e5f60", name: "Galaxy Z Fold7", expiresAt: Date.now() + 250_000 }];
  duration = "never";
  const later = await mount(<PairingPrompt />, "/worlds");
  try {
    assert.ok(document.body.textContent?.includes("Full access to this studio until you revoke it."), "the PC's own setting, not a fixed period");
    const close = document.body.querySelector<HTMLButtonElement>('[aria-label="Decide later"]')!;
    await act(async () => { close.click(); await flush(); });
    assert.ok(!document.body.textContent?.includes("Pair Galaxy Z Fold7?"), "later means this dialog does not return for it");
    assert.ok(!calls.some(c => c.kind === "reject" && c.id.startsWith("7a1c")), "and nothing was decided");
  } finally { await later.unmount(); }
});

it("a browser has no owner controls, so it is never asked", async () => {
  const { element, unmount } = await mount(<PairingPrompt />, "/worlds");
  try { assert.equal(element.innerHTML, ""); } finally { await unmount(); }
});
