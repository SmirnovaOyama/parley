// The service worker: what lets the site be installed as an app, and shows a page of its own
// (offline.html) when a page can't be reached, instead of the browser's. Nothing else is kept:
// every page, file and reply still comes from the server, so a new version shows as soon as it's
// deployed. Requests for the API, downloads and file previews included, pass by untouched.

// A new name when offline.html changes, so a worker installed before fetches the new page.
const CACHE = "offline-2";
const OFFLINE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(new Request(OFFLINE, { cache: "reload" }))));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      // The page's request starts while the worker wakes, not after.
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate" || new URL(event.request.url).pathname.startsWith("/api/")) return;
  event.respondWith(
    (async () => {
      try {
        return (await event.preloadResponse) || (await fetch(event.request));
      } catch {
        return (await caches.match(OFFLINE)) || Response.error();
      }
    })(),
  );
});
