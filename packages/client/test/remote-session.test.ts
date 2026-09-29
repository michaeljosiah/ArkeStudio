import assert from "node:assert/strict";
import { it } from "node:test";
import { prepareRemoteSession, remoteSocketProtocols } from "../src/lib/remote-session.js";

it("requests a fresh channel when a legacy notification worker is replaced", { timeout: 2000 }, async () => {
  const browserKey = "d".repeat(64);
  let oldRequests = 0, newRequests = 0;
  const previousWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const workers = Object.assign(new EventTarget(), {
    register: async () => ({}), ready: Promise.resolve({}),
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
