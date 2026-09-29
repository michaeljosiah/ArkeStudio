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
    return await fetch(path, { ...init, signal: controller.signal });
  } finally { clearTimeout(timer); init.signal?.removeEventListener("abort", abort); }
}

/** The worker adds the origin-bound key to HTTP requests, including native media loads.
 * WebSockets bypass workers and carry it in a subprotocol, never in the bookmark or URL. */
export function prepareRemoteSession(): Promise<void> {
  if (preparing) return preparing;
  preparing = new Promise<void>((resolve, reject) => {
    if (!("serviceWorker" in navigator)) { reject(new RemoteBrowserError("A secure browser connection is required.")); return; }
    const channels: MessageChannel[] = [];
    let settled = false;
    let requested: ServiceWorker | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); navigator.serviceWorker.removeEventListener("controllerchange", send);
      for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
      error ? reject(error) : resolve();
    };
    const send = () => {
      if (settled) return;
      const controller = navigator.serviceWorker.controller;
      if (!controller || controller === requested) return;
      requested = controller;
      // An older notification worker cannot answer. Every new controller gets a fresh
      // channel because the previous worker already owns its transferred port.
      const channel = new MessageChannel(); channels.push(channel);
      channel.port1.addEventListener("message", event => {
        if (settled) return;
        if (typeof event.data !== "string" || !/^[a-f0-9]{64}$/.test(event.data)) { finish(new RemoteBrowserError("Browser storage is unavailable.")); return; }
        browserKey = event.data; finish();
      });
      channel.port1.start();
      try { controller.postMessage("arke-remote-browser-key", [channel.port2]); }
      catch { finish(new Error("The browser connection could not start.")); }
    };
    // Cover registration and activation too: ready never rejects, and a worker update can
    // wait on the network. An existing controller can answer while its update is pending.
    const timer = setTimeout(() => finish(new Error("The browser connection timed out.")), 10_000);
    navigator.serviceWorker.addEventListener("controllerchange", send);
    send();
    void Promise.resolve().then(() => navigator.serviceWorker.register("/notification-worker.js"))
      .then(() => navigator.serviceWorker.ready).then(send, error => {
        finish(["SecurityError", "NotAllowedError", "NotSupportedError"].includes(error?.name)
          ? new RemoteBrowserError("This browser does not allow service workers.") : error);
      });
  }).catch(error => { preparing = null; browserKey = null; throw error; });
  return preparing;
}
export function remoteSocketProtocols(url: string): string[] {
  return url === remoteSocketUrl() && browserKey ? ["arke-remote", "arke-browser." + browserKey] : [];
}
