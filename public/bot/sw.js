// The console's service worker (docs/plan/notifications.md). It makes the
// console installable and shows its push notifications. It caches nothing and
// handles no fetches: the console needs its server anyway, and a cached
// console is how stale pages start.

self.addEventListener("install", () => {
  // A new version takes over at once rather than waiting for every tab to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// A push from the server (agent/lib/push.ts): { title, body, url, tag, urgent }.
self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data ? event.data.text() : "" };
  }
  const title = message.title || "EVE Bot";
  const data = { url: message.url || "/bot" };
  const full = {
    body: message.body || "",
    icon: "/bot/icon-192.png",
    data,
    ...(message.tag ? { tag: message.tag, renotify: true } : {}),
    ...(message.urgent === true ? { requireInteraction: true } : {}),
  };
  // A browser that rejects one of the options still shows the plain notification.
  event.waitUntil(self.registration.showNotification(title, full).catch(() => self.registration.showNotification(title, { body: full.body, data })));
});

// Clicking opens what the notification is about: an open console is focused and taken there, else one is opened.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/bot", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = open.find((client) => new URL(client.url).pathname.startsWith("/bot"));
      if (existing) {
        await existing.focus();
        if (existing.url !== url && "navigate" in existing) await existing.navigate(url).catch(() => undefined);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
