/* Device-local notifications for an open paired browser; no push subscription or offline cache. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
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
