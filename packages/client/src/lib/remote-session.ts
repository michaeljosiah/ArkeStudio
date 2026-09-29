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
/** The worker adds the origin-bound key to HTTP requests, including native media loads.
 * WebSockets bypass workers and carry it in a subprotocol, never in the bookmark or URL. */
export function prepareRemoteSession(): Promise<void> {
  if (preparing) return preparing;
  preparing = (async () => {
    if (!("serviceWorker" in navigator)) throw new Error("A secure browser connection is required.");
    await navigator.serviceWorker.register("/notification-worker.js");
    await navigator.serviceWorker.ready;
    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel();
      const finish = (error?: Error) => {
        clearTimeout(timer); navigator.serviceWorker.removeEventListener("controllerchange", send);
        channel.port1.close(); channel.port2.close(); error ? reject(error) : resolve();
      };
      const send = () => navigator.serviceWorker.controller?.postMessage("arke-remote-browser-key", [channel.port2]);
      const timer = setTimeout(() => finish(new Error("Browser storage is unavailable.")), 10000);
      channel.port1.addEventListener("message", event => {
        if (typeof event.data !== "string" || !/^[a-f0-9]{64}$/.test(event.data)) { finish(new Error("Browser storage is unavailable.")); return; }
        browserKey = event.data; finish();
      });
      channel.port1.start();
      if (navigator.serviceWorker.controller) send();
      else navigator.serviceWorker.addEventListener("controllerchange", send, { once: true });
    });
  })().catch(error => { preparing = null; browserKey = null; throw error; });
  return preparing;
}
export function remoteSocketProtocols(url: string): string[] {
  return url === remoteSocketUrl() && browserKey ? ["arke-remote", "arke-browser." + browserKey] : [];
}
