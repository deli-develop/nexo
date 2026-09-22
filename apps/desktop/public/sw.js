/**
 * The service worker.
 *
 * # What it caches, and the one thing it must never cache
 *
 * It caches the **shell**: the document, the JavaScript, the stylesheet, the
 * fonts and the wasm module. That is what makes the app open at all with no
 * network, and what makes a second visit instant.
 *
 * It does **not** cache anything from the API, and it must not be made to.
 * Two reasons, and the second is the one that matters:
 *
 *  1. Everything there is already local — messages live in IndexedDB, and a
 *     cached `/v1/conversations/…/sync` would be a second, staler copy.
 *  2. A cached response is a plaintext copy of somebody's data sitting in a
 *     place nothing in this app knows how to wipe. `logout` clears IndexedDB;
 *     it has no idea this cache exists. The one rule that keeps sign-out
 *     meaning something is that nothing personal is ever put here.
 *
 * So: same-origin GETs only, and only for the shell. Every other request goes
 * straight to the network and is never looked at again.
 *
 * # Why it is written by hand
 *
 * Workbox would generate this, and generate a precache manifest with it — a
 * build step, a dependency, and a list of filenames that has to be kept in
 * step with the bundler's hashes. What is here is forty lines of the same
 * behaviour with a strategy that needs no manifest: serve from cache, and
 * refresh in the background.
 */

const CACHE = "nexo-shell-v1";

/**
 * The document, cached at install so a cold start with no network still opens.
 *
 * Only the document: the hashed assets it references are cached as they are
 * asked for, and listing them here would mean maintaining the bundler's
 * output by hand.
 */
const SHELL = ["/", "/index.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      // A failed precache must not stop the worker installing. The app works
      // online either way, and refusing to install would mean it never gets
      // the chance to try again.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Anything not served by this site — the API, the object store — is the
  // network's business and nobody else's. Not intercepted at all, so there is
  // no code path that could accidentally put one in a cache.
  if (url.origin !== self.location.origin) return;

  // A navigation always tries the network first, so a deploy is visible on the
  // next load rather than whenever the cache happens to turn over. The cached
  // document is the offline answer, not the normal one.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put("/index.html", copy));
          return response;
        })
        .catch(() => caches.match("/index.html").then((hit) => hit ?? Response.error())),
    );
    return;
  }

  // Everything else the site serves is content-hashed, so a hit is always
  // correct and never stale: a changed file has a different name.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
