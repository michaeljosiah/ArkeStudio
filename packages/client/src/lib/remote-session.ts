/** Only the hosted copy of index.html receives this marker. Desktop and Vite keep their
 * existing private bridge / terminal handoff and never fetch a public process capability. */
export function isRemoteSession(): boolean {
  return typeof window !== "undefined" && !window.arke && typeof document !== "undefined"
    && document.querySelector('meta[name="arke-remote"]')?.getAttribute("content") === "true";
}
export function remoteSocketUrl(): string | null {
  return isRemoteSession() ? window.location.origin.replace(/^https:/, "wss:") + "/" : null;
}

let browserKey: string | null = null;
let preparing: Promise<void> | null = null;
export class RemoteBrowserError extends Error {}

/** The page's own Studio requests carry the key themselves. The worker adds it too, but only to
 * the requests it handles, and on a phone that is not all of them: an installed app relaunched
 * cold after a lock or a fold loads before its worker is running, or without it in control, and
 * those requests reached the PC bare. The PC cannot open the device cookie without the key, so it
 * answered "not paired" and a paired phone was sent to pairing. */
export function withBrowserKey(init: RequestInit = {}): RequestInit {
  if (!browserKey) return init;
  const headers = new Headers(init.headers);
  headers.set("x-arke-browser-key", browserKey);
  return { ...init, headers };
}

/** A sleeping host or switching phone network must not occupy the gate's only request
 * forever. Abort the attempt so its existing polling can discover the host again. */
export async function remoteFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  // AbortSignal.any is absent on older iPhones; forwarding cancellation needs only the
  // same AbortController support as fetch itself, including an already-aborted parent.
  const abort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(path, withBrowserKey({ ...init, signal: controller.signal }));
  } finally { clearTimeout(timer); init.signal?.removeEventListener("abort", abort); }
}

/** The origin's key, from the store the worker reads (public/notification-worker.js): one
 * readwrite transaction, so a page and a worker reaching for a first key together agree on it.
 * IndexedDB is isolated by origin, including port; cookies are not. */
function readBrowserKey(): Promise<string> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open("arke-remote-browser", 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore("keys");
    opening.addEventListener("error", () => reject(opening.error));
    opening.onblocked = () => reject(new Error("Browser storage is unavailable"));
    opening.onsuccess = () => {
      const db = opening.result;
      const transaction = db.transaction("keys", "readwrite");
      const store = transaction.objectStore("keys");
      const request = store.get("browser");
      let key: unknown;
      request.onsuccess = () => {
        key = request.result;
        if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) {
          key = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
          store.put(key, "browser");
        }
      };
      transaction.oncomplete = () => { db.close(); resolve(key as string); };
      transaction.addEventListener("abort", () => { db.close(); reject(transaction.error); });
    };
  });
}

/** The page reads the origin-bound key itself and the worker adds it to native media loads,
 * which cannot carry a header. WebSockets carry it in a subprotocol, never in the bookmark or URL.
 * Nothing here waits for the worker to take control: a page it does not control waited for a
 * controller that never came and stood on "Not answering" for good. */
export function prepareRemoteSession(): Promise<void> {
  if (preparing) return preparing;
  preparing = new Promise<void>((resolve, reject) => {
    if (!("serviceWorker" in navigator)) { reject(new RemoteBrowserError("A secure browser connection is required.")); return; }
    if (typeof indexedDB === "undefined") { reject(new RemoteBrowserError("Browser storage is unavailable.")); return; }
    let settled = false;
    const finish = (error?: Error, key?: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else { browserKey = key!; resolve(); }
    };
    const timer = setTimeout(() => finish(new Error("The browser connection timed out.")), 10_000);
    // Registration still has to be allowed: without the worker no picture or clip can load.
    const registered = Promise.resolve().then(() => navigator.serviceWorker.register("/notification-worker.js")).then(claimed, (error: { name?: string } | undefined) => {
      throw ["SecurityError", "NotAllowedError", "NotSupportedError"].includes(error?.name ?? "")
        ? new RemoteBrowserError("This browser does not allow service workers.") : error;
    });
    const key = readBrowserKey().then(read => {
      if (!/^[a-f0-9]{64}$/.test(read)) throw new RemoteBrowserError("Browser storage is unavailable.");
      return read;
    }, () => { throw new RemoteBrowserError("Browser storage is unavailable."); });
    Promise.all([key, registered]).then(([read]) => finish(undefined, read), finish);
  }).catch(error => { preparing = null; browserKey = null; throw error; });
  return preparing;
}

/** Media cannot carry the key itself, so a page the worker does not control asks the active
 * worker to claim it. Bounded: a worker that cannot answer (an older one, or one still
 * installing, which claims on activation) must not keep the studio from opening. */
function claimed(registration: ServiceWorkerRegistration | undefined): Promise<void> {
  const workers = navigator.serviceWorker;
  if (workers.controller) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); workers.removeEventListener("controllerchange", done); resolve(); };
    const timer = setTimeout(done, 3000);
    workers.addEventListener("controllerchange", done);
    // A ServiceWorker message has no target origin; the worker checks the sender's.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    registration?.active?.postMessage("arke-remote-claim");
  });
}
export function remoteSocketProtocols(url: string): string[] {
  return url === remoteSocketUrl() && browserKey ? ["arke-remote", "arke-browser." + browserKey] : [];
}
