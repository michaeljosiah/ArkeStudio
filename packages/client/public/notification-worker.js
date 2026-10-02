/* Device-local notifications for an open paired browser; no push subscription or offline cache. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

// IndexedDB is isolated by origin, including port; cookies are not. Keep this key out of URLs
// and attach it only to Studio requests. A worker restart reopens the same persisted key.
function browserKey() {
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
      let key;
      request.onsuccess = () => {
        key = request.result;
        if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) {
          key = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
          store.put(key, "browser");
        }
      };
      transaction.oncomplete = () => { db.close(); resolve(key); };
      transaction.addEventListener("abort", () => { db.close(); reject(transaction.error); });
    };
  });
}
self.addEventListener("message", event => {
  if (!event.source?.url || new URL(event.source.url).origin !== self.location.origin) return;
  // A page loaded while this worker was not in control (a cold relaunch of the installed app)
  // asks to be claimed, so its pictures and clips go through here and carry the key.
  if (event.data === "arke-remote-claim") { event.waitUntil(self.clients.claim()); return; }
  if (event.data !== "arke-remote-browser-key") return;
  event.waitUntil(browserKey().then(key => event.ports[0]?.postMessage(key)).catch(() => event.ports[0]?.postMessage(null)));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !/^\/(remote\/|media\/|genesis-media\/)/.test(url.pathname)) return;
  event.respondWith(browserKey().then(key => {
    const headers = new Headers(event.request.headers);
    headers.set("x-arke-browser-key", key);
    // A redirect must never forward this origin's key to another service.
    return fetch(new Request(event.request, { headers, mode: "same-origin", redirect: "error" }));
  }).catch(() => new Response("Browser storage is unavailable.", { status: 503 })));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async clients => {
    const client = clients[0];
    if (client) {
      await client.focus();
      // ServiceWorker Client.postMessage has no targetOrigin argument.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      client.postMessage("arke-open-activity");
    }
  }));
});
