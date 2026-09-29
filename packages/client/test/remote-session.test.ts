import assert from "node:assert/strict";
import { it } from "node:test";
import { prepareRemoteSession, remoteSocketProtocols, remoteFetch, RemoteBrowserError } from "../src/lib/remote-session.js";

it("bounds worker registration and activation, then permits another attempt", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
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
    workers.register = async () => ({});
    const activation = assert.rejects(prepareRemoteSession(), /timed out/);
    await Promise.resolve();
    t.mock.timers.tick(10_000);
    await activation;
  } finally {
    if (previous) Object.defineProperty(navigator, "serviceWorker", previous); else Reflect.deleteProperty(navigator, "serviceWorker");
  }
});

it("distinguishes unavailable browser storage from an unavailable network", async () => {
  const previous = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  const workers = Object.assign(new EventTarget(), {
    register: async () => ({}), ready: Promise.resolve({}),
    controller: { postMessage: (_message: unknown, ports: MessagePort[]) => {
      // MessagePort is private and takes no targetOrigin.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      ports[0]!.postMessage(null);
    } },
  });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: workers });
  try { await assert.rejects(prepareRemoteSession(), RemoteBrowserError); }
  finally {
    if (previous) Object.defineProperty(navigator, "serviceWorker", previous); else Reflect.deleteProperty(navigator, "serviceWorker");
  }
});

it("reports service-worker policy refusal as a browser limitation", async () => {
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

it("requests a fresh channel when a legacy notification worker is replaced", { timeout: 2000 }, async () => {
  const browserKey = "d".repeat(64);
  let oldRequests = 0, newRequests = 0;
  const previousWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const workers = Object.assign(new EventTarget(), {
    register: () => new Promise<object>(() => {}), ready: Promise.resolve({}),
    controller: { postMessage: (_message: unknown, _ports: MessagePort[]) => {} },
  });
  const replacement = { postMessage: (_message: unknown, ports: MessagePort[]) => {
    newRequests++;
    // MessagePort is a private channel, not Window.postMessage.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    ports[0]!.postMessage(browserKey);
  } };
  workers.controller = { postMessage: () => {
    oldRequests++;
    queueMicrotask(() => { workers.controller = replacement; workers.dispatchEvent(new Event("controllerchange")); });
  } };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: workers });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://studio.example.ts.net:9443" } } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => ({ getAttribute: () => "true" }) } });
  try {
    await prepareRemoteSession();
    assert.equal(oldRequests, 1); assert.equal(newRequests, 1);
    assert.deepEqual(remoteSocketProtocols("wss://studio.example.ts.net:9443/"), ["arke-remote", "arke-browser." + browserKey]);
    assert.deepEqual(remoteSocketProtocols("wss://studio.example.ts.net/"), []);
    workers.dispatchEvent(new Event("controllerchange"));
    assert.equal(newRequests, 1, "the upgrade listener is removed after preparation");
  } finally {
    for (const [target, name, descriptor] of [[navigator, "serviceWorker", previousWorker], [globalThis, "window", previousWindow], [globalThis, "document", previousDocument]] as const) {
      if (descriptor) Object.defineProperty(target, name, descriptor); else Reflect.deleteProperty(target, name);
    }
  }
});
