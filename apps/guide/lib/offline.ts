/**
 * Uso senza rete: registrazione del service worker (public/sw.js) e scaricamento di un bundle.
 *
 * Un bundle è "disponibile offline" quando manifest e tutti i suoi file sono nella cache del dispositivo.
 * Le chiavi dei cache devono restare allineate a public/sw.js.
 */
import type { BundleManifest } from "@guide/bundle/client";

export const SHELL_CACHE = "guide-shell-v1";
export const BUNDLE_CACHE = "guide-bundles-v1";
export const INDEX_URL = "/bundles/index.json";

export function registerServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (process.env.NODE_ENV !== "production") return; // in sviluppo la cache confonderebbe le modifiche
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

export function offlineSupported(): boolean {
  return typeof caches !== "undefined";
}

/** Indirizzi da tenere in cache per un bundle: indice, manifest e file elencati nel manifest. */
export function bundleUrls(manifestUrl: string, manifest: Pick<BundleManifest, "files">): string[] {
  const base = manifestUrl.replace(/manifest\.json$/, "");
  return [INDEX_URL, manifestUrl, ...manifest.files.map((f) => base + f.path)];
}

/** Risorse della pagina attuale (script e fogli di stile di Next), per aprire l'app senza rete. */
function shellUrls(): string[] {
  const urls = new Set<string>(["/"]);
  for (const el of document.querySelectorAll<HTMLScriptElement>("script[src]")) urls.add(new URL(el.src).pathname);
  for (const el of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href], link[rel="icon"][href]')) {
    urls.add(new URL(el.href).pathname);
  }
  return [...urls].filter((u) => u === "/" || u.startsWith("/_next/static/") || u.startsWith("/icon"));
}

export async function isBundleCached(manifestUrl: string, manifest: BundleManifest): Promise<boolean> {
  if (!offlineSupported()) return false;
  const cache = await caches.open(BUNDLE_CACHE);
  for (const url of bundleUrls(manifestUrl, manifest)) if (!(await cache.match(url))) return false;
  return true;
}

/** Scarica il bundle e l'app nella cache. `onProgress` riceve la frazione completata (0–1). */
export async function downloadBundle(
  manifestUrl: string,
  manifest: BundleManifest,
  onProgress: (fraction: number) => void = () => undefined,
): Promise<void> {
  const bundle = await caches.open(BUNDLE_CACHE);
  const shell = await caches.open(SHELL_CACHE);
  const jobs: [Cache, string][] = [
    ...bundleUrls(manifestUrl, manifest).map((u): [Cache, string] => [bundle, u]),
    ...shellUrls().map((u): [Cache, string] => [shell, u]),
  ];
  let done = 0;
  for (const [cache, url] of jobs) {
    // add() rifiuta le risposte non riuscite: un download a metà non risulta mai completo.
    await cache.add(new Request(url, { cache: "reload" }));
    onProgress(++done / jobs.length);
  }
}

export async function removeBundle(manifestUrl: string, manifest: BundleManifest): Promise<void> {
  const cache = await caches.open(BUNDLE_CACHE);
  for (const url of bundleUrls(manifestUrl, manifest)) if (url !== INDEX_URL) await cache.delete(url);
}
