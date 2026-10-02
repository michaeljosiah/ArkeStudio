import { prepareRemoteSession } from "../src/lib/remote-session.js";

type Callback = (() => void) | null | undefined;
/** The one IndexedDB shape the page and the worker use: a "keys" store holding "browser". linkedom
 * has none, and microtasks rather than timers keep it usable under mocked setTimeout. */
export function installTestBrowserStorage(options: { key?: unknown; fails?: boolean } = {}): Map<string, unknown> {
  const data = new Map<string, unknown>();
  if (options.key !== undefined) data.set("browser", options.key);
  let exists = options.key !== undefined;
  const indexedDB = {
    open() {
      const listeners: Record<string, Callback> = {};
      const opening = { result: undefined as unknown, error: null as unknown, onupgradeneeded: null as Callback,
        onsuccess: null as Callback, onblocked: null as Callback,
        addEventListener(type: string, callback: () => void) { listeners[type] = callback; } };
      queueMicrotask(() => {
        if (options.fails) { opening.error = new DOMException("Storage is disabled", "UnknownError"); listeners["error"]?.(); return; }
        opening.result = { createObjectStore() {}, close() {}, transaction() {
          const transaction = { error: null, oncomplete: null as Callback, addEventListener() {},
            objectStore: () => ({
              get(name: string) {
                const request = { result: undefined as unknown, onsuccess: null as Callback };
                queueMicrotask(() => { request.result = data.get(name); request.onsuccess?.(); queueMicrotask(() => transaction.oncomplete?.()); });
                return request;
              },
              put(value: unknown, name: string) { data.set(name, value); },
            }) };
          return transaction;
        } };
        if (!exists) { exists = true; opening.onupgradeneeded?.(); }
        opening.onsuccess?.();
      });
      return opening;
    },
  };
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: indexedDB });
  return data;
}

export async function prepareTestRemoteBrowser() {
  installTestBrowserStorage({ key: "b".repeat(64) });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
    register: async () => ({}), ready: Promise.resolve({}), controller: null,
    addEventListener() {}, removeEventListener() {},
  } });
  await prepareRemoteSession();
}
