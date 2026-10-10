/**
 * Service worker della guida: rende l'app utilizzabile senza rete.
 *
 * - pagina e risorse statiche di Next: in cache, aggiornate quando c'è rete;
 * - file dei bundle (contenuti e immagini): hanno l'hash nel nome, quindi non cambiano mai → prima la cache;
 * - indice e manifest dei bundle: prima la rete (per vedere le nuove versioni), la cache se manca;
 * - video ambientali: mai in cache (richieste a intervalli, pesanti, non servono offline);
 * - /api/: mai in cache.
 *
 * Le chiavi dei cache devono restare allineate a lib/offline.ts.
 */
const SHELL = "guide-shell-v1";
const BUNDLES = "guide-bundles-v1";
const KEEP = [SHELL, BUNDLES];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.add("/")).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("guide-") && !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (/\.(mp4|webm)$/i.test(url.pathname) || request.headers.has("range")) return;

  if (url.pathname.startsWith("/bundles/")) {
    const immutable = /\/(content\.[0-9a-f]+\.json|media\/[^/]+)$/.test(url.pathname);
    event.respondWith(immutable ? cacheFirst(request, BUNDLES) : networkFirst(request, BUNDLES));
  } else if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request, SHELL));
  } else if (request.mode === "navigate") {
    // Una sola pagina: qualunque navigazione senza rete riceve la pagina principale.
    event.respondWith(networkFirst(request, SHELL, "/"));
  } else {
    event.respondWith(networkFirst(request, SHELL));
  }
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

/** Prima la rete, con un limite di tempo: con una rete lentissima vale la copia in cache. */
async function networkFirst(request, cacheName, fallbackPath) {
  const cache = await caches.open(cacheName);
  try {
    const response = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    if (response.ok) cache.put(fallbackPath ?? request, response.clone());
    return response;
  } catch (error) {
    const hit = (await cache.match(request)) ?? (fallbackPath ? await cache.match(fallbackPath) : undefined);
    if (hit) return hit;
    throw error;
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
