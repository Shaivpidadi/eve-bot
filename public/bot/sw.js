// The console's service worker (docs/plan/notifications.md). It makes the
// console installable and, from N2, shows push notifications. It caches
// nothing and handles no fetches: the console needs its server anyway, and a
// cached console is how stale pages start.

self.addEventListener("install", () => {
  // A new version takes over at once rather than waiting for every tab to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
