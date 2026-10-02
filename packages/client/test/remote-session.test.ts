import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { prepareRemoteSession, remoteSocketProtocols, remoteFetch, RemoteBrowserError } from "../src/lib/remote-session.js";
import { installTestBrowserStorage } from "./remote-browser.js";

it("bounds a registration that never settles, then permits another attempt", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  installTestBrowserStorage({ key: "e".repeat(64) });
  const previous = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  const workers = Object.assign(new EventTarget(), {
    register: () => new Promise<object>(() => {}),
    ready: new Promise<object>(() => {}), controller: null,
  });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: workers });
  try {
    const registration = assert.rejects(prepareRemoteSession(), /timed out/);
    t.mock.timers.tick(10_000);
    await registration;
    assert.deepEqual(remoteSocketProtocols("wss://studio.example.ts.net:9443/"), [], "a failed attempt holds no key");
  } finally {
    if (previous) Object.defineProperty(navigator, "serviceWorker", previous); else Reflect.deleteProperty(navigator, "serviceWorker");
  }
});

it("distinguishes unavailable browser storage from an unavailable network", async () => {
  installTestBrowserStorage({ fails: true });
  const previous = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  const workers = Object.assign(new EventTarget(), { register: async () => ({}), ready: Promise.resolve({}), controller: null });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: workers });
  try { await assert.rejects(prepareRemoteSession(), RemoteBrowserError); }
  finally {
    if (previous) Object.defineProperty(navigator, "serviceWorker", previous); else Reflect.deleteProperty(navigator, "serviceWorker");
  }
});

it("reports service-worker policy refusal as a browser limitation", async () => {
  installTestBrowserStorage({ key: "e".repeat(64) });
  const previous = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  const workers = Object.assign(new EventTarget(), {
    register: async () => { throw new DOMException("Disabled by browser policy", "SecurityError"); },
    ready: new Promise<object>(() => {}), controller: null,
  });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: workers });
  try { await assert.rejects(prepareRemoteSession(), RemoteBrowserError); }
  finally {
    if (previous) Object.defineProperty(navigator, "serviceWorker", previous); else Reflect.deleteProperty(navigator, "serviceWorker");
  }
});

it("aborts a stalled session request and permits the next check", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previous = globalThis.fetch;
  globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
  });
  try {
    const failed = assert.rejects(remoteFetch("/remote/session"), { name: "AbortError" });
    t.mock.timers.tick(10_000);
    await failed;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    assert.equal((await remoteFetch("/remote/session")).status, 204);
  } finally { globalThis.fetch = previous; }
});

it("forwards caller cancellation without AbortSignal.any and removes its listener", async t => {
  const previous = globalThis.fetch;
  t.mock.method(AbortSignal, "any", () => { throw new Error("Unavailable on this browser"); });
  globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    if (init!.signal!.aborted) reject(init!.signal!.reason);
    else init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
  });
  try {
    const controller = new AbortController();
    const remove = t.mock.method(controller.signal, "removeEventListener");
    const cancelled = assert.rejects(remoteFetch("/remote/session", { signal: controller.signal }), { name: "AbortError" });
    controller.abort();
    await cancelled;
    assert.equal(remove.mock.callCount(), 1);
    await assert.rejects(remoteFetch("/remote/session", { signal: controller.signal }), { name: "AbortError" });
  } finally { globalThis.fetch = previous; }
});

it("a page no worker controls still gets its key and sends it on its own requests", { timeout: 2000 }, async () => {
  // An installed app relaunched cold after a lock or a fold: registered, but nothing in control
  // and nothing activating. The page used to wait for a controller here and never got its key.
  const stored = installTestBrowserStorage();
  const previousWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousFetch = globalThis.fetch;
  const claims: unknown[] = [];
  const workers: EventTarget & { register(): Promise<object>; ready: Promise<object>; controller: object | null } = Object.assign(new EventTarget(), {
    register: async () => ({ active: { postMessage: (message: unknown) => {
      // The active worker answers a claim by taking control of the page.
      claims.push(message); queueMicrotask(() => { workers.controller = {}; workers.dispatchEvent(new Event("controllerchange")); });
    } } }),
    ready: new Promise<object>(() => {}), controller: null,
  });
  const sent: (string | null)[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Headers(init?.headers).get("x-arke-browser-key"));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: workers });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://studio.example.ts.net:9443" } } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => ({ getAttribute: () => "true" }) } });
  try {
    await prepareRemoteSession();
    assert.deepEqual(claims, ["arke-remote-claim"], "the active worker is asked to take control, so media carries the key");
    assert.ok(workers.controller);
    const key = stored.get("browser") as string;
    assert.match(key, /^[a-f0-9]{64}$/, "a first visit makes the key the worker will read");
    await remoteFetch("/remote/session");
    assert.deepEqual(sent, [key], "the request carries the key without the worker");
    assert.deepEqual(remoteSocketProtocols("wss://studio.example.ts.net:9443/"), ["arke-remote", "arke-browser." + key]);
    assert.deepEqual(remoteSocketProtocols("wss://studio.example.ts.net/"), []);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [target, name, descriptor] of [[navigator, "serviceWorker", previousWorker], [globalThis, "window", previousWindow], [globalThis, "document", previousDocument]] as const) {
      if (descriptor) Object.defineProperty(target, name, descriptor); else Reflect.deleteProperty(target, name);
    }
  }
});

it("the page and the worker read the key from the same store", () => {
  const page = readFileSync(new URL("../src/lib/remote-session.ts", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../public/notification-worker.js", import.meta.url), "utf8");
  for (const shared of ['indexedDB.open("arke-remote-browser", 1)', 'createObjectStore("keys")', 'transaction("keys", "readwrite")',
    'store.get("browser")', 'store.put(key, "browser")', "/^[a-f0-9]{64}$/"]) {
    assert.ok(page.includes(shared) && worker.includes(shared), `both copies use ${shared}`);
  }
});
