/**
 * Service worker della guida: rende l'app utilizzabile senza rete.
 *
 * - pagina e risorse statiche di Next: in cache, aggiornate quando c'è rete;
 * - file dei bundle (contenuti e immagini): hanno l'hash nel nome, quindi non cambiano mai → prima la cache;
 *   vale per i bundle dei file (/bundles/) e per quelli pubblicati dallo Studio (/pub/, stesso dominio);
 * - indice e manifest dei bundle: prima la rete (per vedere le nuove versioni), la cache se manca;
 * - video ambientali: mai in cache (richieste a intervalli, pesanti, non servono offline);
 * - /api/, /studio, /account e /auth: mai in cache (dati riservati e sessioni; funzionano solo online);
 * - sito protetto con nome utente e password (lib/site-lock.ts): alla prima risposta 401 si cancellano tutte le
 *   copie sul dispositivo, così chi non ha le credenziali non riapre l'app nemmeno senza rete.
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
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || /^\/(studio|account|auth)(\/|$)/.test(url.pathname)) return;
  if (/\.(mp4|webm)$/i.test(url.pathname) || request.headers.has("range")) return;

  if (url.pathname.startsWith("/bundles/") || url.pathname.startsWith("/pub/")) {
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

/** Accesso riservato (401): nessuna copia deve restare sul dispositivo. */
async function forgetIfLocked(response) {
  if (response.status !== 401) return;
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k.startsWith("guide-")).map((k) => caches.delete(k)));
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  else await forgetIfLocked(response);
  return response;
}

/** Prima la rete, con un limite di tempo: con una rete lentissima vale la copia in cache. */
async function networkFirst(request, cacheName, fallbackPath) {
  const cache = await caches.open(cacheName);
  try {
    const response = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    if (response.ok) cache.put(fallbackPath ?? request, response.clone());
    else await forgetIfLocked(response);
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
