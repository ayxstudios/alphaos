/* AlphaOS service worker (docs/PERF.md): a durable cache for the app's static
 * build files only, so a phone on a slow connection loads the shell's
 * JavaScript, CSS and fonts from the device instead of the network.
 *
 * It caches ONLY /_next/static/* (content-hashed, immutable, identical for
 * every user). It never touches page HTML, RSC payloads, API responses,
 * images or anything else that can carry user data: those requests are not
 * intercepted at all and go straight to the network as if there were no
 * worker. Registered as /sw.js?v=<build id>; a new deploy installs a new
 * worker, which deletes the previous build's cache when it activates.
 */
const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE = `alphaos-static-${VERSION}`;
const PREFIX = "alphaos-static-";

self.addEventListener("install", (event) => {
  // Where the browser supports static routing (Chrome 123+), page loads skip
  // the worker entirely instead of waking it just to pass them through.
  if (typeof event.addRoutes === "function") {
    event.addRoutes([{ condition: { requestMode: "navigate" }, source: "network" }]).catch(() => {});
  }
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/_next/static/")) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })(),
  );
});
