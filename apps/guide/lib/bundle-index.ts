/**
 * Indice dei bundle che l'app mostra. Due origini:
 * - i bundle compilati dai file del repository al build (`/bundles/index.json`, in public/);
 * - i bundle pubblicati dallo Studio nel bucket pubblico «bundles» di Supabase, serviti dallo stesso
 *   dominio dell'app attraverso `/pub/` (riscrittura in next.config.ts), così funzionano anche il service
 *   worker e l'uso senza rete.
 * Una destinazione pubblicata dallo Studio sostituisce quella dei file: da quel momento la sua fonte è
 * il database. Puro: usato dall'app, dal server delle domande, dalla pipeline e dallo script di build.
 */
import type { BundleContent } from "@guide/bundle/client";

export interface BundleIndexEntry {
  destination: string;
  name: string;
  locale: string;
  fictional: boolean;
  /** Bundle di anteprima: territorio con contenuti ancora in revisione. */
  preview?: boolean;
  manifest: string;
  /** Copertina per la pagina iniziale (immagine, video facoltativo, testo alternativo, credito). */
  cover?: { image: string; video?: string; alt: string; credit?: string };
}

export interface BundleIndex {
  bundles: BundleIndexEntry[];
}

export const STATIC_INDEX_URL = "/bundles/index.json";
export const PUB_PREFIX = "/pub/";
export const PUB_INDEX_URL = `${PUB_PREFIX}index.json`;
/** Bucket pubblico dei bundle pubblicati. */
export const BUNDLES_BUCKET = "bundles";

/** Indirizzo pubblico di Supabase da cui si leggono i bundle pubblicati (null: solo i bundle dei file). */
export function publishedOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, "");
  return url && /^https?:\/\/[^/]+$/.test(url) ? url : null;
}

/** `/pub/<percorso>` → indirizzo dell'oggetto nel bucket pubblico (per il server, che non passa da /pub/). */
export function pubToStorageUrl(url: string, origin: string): string {
  if (!url.startsWith(PUB_PREFIX)) throw new Error(`non è un indirizzo pubblicato: ${url}`);
  return `${origin}/storage/v1/object/public/${BUNDLES_BUCKET}/${url.slice(PUB_PREFIX.length)}`;
}

/** Cartella di un bundle nel bucket e indirizzo con cui l'app lo legge. */
export const bundleFolder = (destination: string, locale: string) => `${destination}/${locale}-full`;
export const pubBase = (destination: string, locale: string) => `${PUB_PREFIX}${bundleFolder(destination, locale)}/`;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NAMESPACED_MANIFEST = new RegExp(`${UUID}/manifest\\.json$`);

/**
 * Cartella da cui si risolvono i file di un bundle (contenuti, media, copertine). Nella struttura precedente è
 * quella del manifest (`…/<lingua>-full/manifest.json`); nelle pubblicazioni immutabili il manifest sta nella
 * cartella della pubblicazione (`…/<lingua>-full/<id>/manifest.json`) ma i percorsi del manifest restano relativi
 * alla cartella della lingua (`<id>/content.….json`, `media/…`): i media sono condivisi tra le pubblicazioni.
 */
export function bundleBase(manifestUrl: string): string {
  return manifestUrl.replace(NAMESPACED_MANIFEST, "").replace(/manifest\.json$/, "");
}

/** Identificativo della pubblicazione dal manifest (null nella struttura precedente). */
export function manifestPublication(manifestUrl: string): string | null {
  return new RegExp(`/(${UUID})/manifest\\.json$`).exec(manifestUrl)?.[1] ?? null;
}

/** Fotografie numerate dell'indice pubblico nel bucket: `index/<numero a 20 cifre>.json`. */
export const INDEX_DIR = "index";
export const INDEX_FILE = /^[0-9]{20}\.json$/;
/** Indice della struttura precedente, usato solo finché non c'è nessuna fotografia numerata. */
export const LEGACY_INDEX_OBJECT = "index.json";

/**
 * Oggetto del bucket con l'indice in vigore: la fotografia col numero più alto in `index/` (le fotografie sono
 * immutabili e numerate in ordine: vedi studio_index_snapshot), oppure il vecchio index.json se non ce n'è
 * nessuna. `list` elenca `index/` in ordine di nome decrescente (come l'API Storage con sortBy).
 */
export async function currentIndexObject(
  list: () => Promise<{ data: { name: string }[] | null; error: { message: string } | null }>,
): Promise<{ ok: true; object: string } | { ok: false; error: string }> {
  let result: Awaited<ReturnType<typeof list>>;
  try {
    result = await list();
  } catch (e) {
    return { ok: false, error: `elenco degli indici: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (result.error || !result.data) return { ok: false, error: `elenco degli indici: ${result.error?.message ?? "risposta vuota"}` };
  const latest = result.data.map((f) => f.name).filter((n) => INDEX_FILE.test(n)).sort().pop();
  return { ok: true, object: latest ? `${INDEX_DIR}/${latest}` : LEGACY_INDEX_OBJECT };
}

/** Elenco anonimo di `index/` attraverso l'API Storage (per il server: proxy e domande). */
export function listIndexObjects(origin: string, anonKey: string, fetchFn: typeof fetch = fetch) {
  return async () => {
    const r = await fetchFn(`${origin}/storage/v1/object/list/${BUNDLES_BUCKET}`, {
      method: "POST",
      headers: { apikey: anonKey, authorization: `Bearer ${anonKey}`, "content-type": "application/json" },
      body: JSON.stringify({ prefix: INDEX_DIR, limit: 1, offset: 0, sortBy: { column: "name", order: "desc" } }),
      cache: "no-store",
    });
    if (!r.ok) return { data: null, error: { message: `HTTP ${r.status}` } };
    return { data: (await r.json()) as { name: string }[], error: null };
  };
}

/** Voce dell'indice di un bundle compilato; `base` è la cartella da cui l'app lo legge (con «/» finale). */
export function indexEntry(content: BundleContent, base: string): BundleIndexEntry {
  const covers = content.media.filter((m) => m.cover);
  const coverImage = covers.find((m) => !m.kind) ?? covers.find((m) => m.poster);
  const coverVideo = covers.find((m) => m.kind === "video");
  const credit = coverImage ? (coverImage.attribution ?? coverImage.author) : undefined;
  return {
    destination: content.destination,
    name: content.name,
    locale: content.locale,
    fictional: content.fictional,
    preview: content.preview,
    manifest: `${base}manifest.json`,
    ...(coverImage
      ? {
          cover: {
            image: base + (coverImage.kind === "video" ? coverImage.poster! : coverImage.path),
            ...(coverVideo ? { video: base + coverVideo.path } : {}),
            alt: coverImage.alt,
            ...(credit ? { credit } : {}),
          },
        }
      : {}),
  };
}

/** Ordine dell'indice: prima i territori reali, poi quelli di prova; per nome e lingua. */
export function sortEntries(entries: BundleIndexEntry[]): BundleIndexEntry[] {
  return [...entries].sort(
    (a, b) => Number(a.fictional) - Number(b.fictional) || a.name.localeCompare(b.name) || a.locale.localeCompare(b.locale),
  );
}

/**
 * Unione dei due indici: per ogni destinazione pubblicata dallo Studio valgono solo le sue voci (tutte le
 * lingue pubblicate); le altre destinazioni restano quelle dei file. Le voci pubblicate devono puntare a /pub/.
 */
export function mergeIndexes(staticEntries: BundleIndexEntry[], published: BundleIndexEntry[] | null | undefined): BundleIndexEntry[] {
  // Una voce vale solo se punta alla cartella del suo territorio: un indice manomesso non può far leggere a un
  // territorio i file di un altro.
  const valid = (published ?? []).filter((e) =>
    typeof e?.destination === "string" && typeof e.manifest === "string" && e.manifest.startsWith(`${PUB_PREFIX}${e.destination}/`)
    && !e.manifest.includes("..") && (!e.cover || [e.cover.image, e.cover.video].every((u) => u === undefined || u.startsWith(`${PUB_PREFIX}${e.destination}/`))));
  const replaced = new Set(valid.map((e) => e.destination));
  return sortEntries([...staticEntries.filter((e) => !replaced.has(e.destination)), ...valid]);
}

/**
 * Esito della lettura dell'indice pubblicato. Un errore (rete, HTTP, JSON non valido, forma sbagliata) non
 * diventa mai «nessuna voce»: chi lo usa sa che le destinazioni dello Studio non sono note in questo momento.
 */
export type PublishedIndexResult = { ok: true; entries: BundleIndexEntry[] } | { ok: false; error: string };

export async function fetchPublishedIndex(fetchFn: (url: string) => Promise<Response>, url: string): Promise<PublishedIndexResult> {
  let response: Response;
  try {
    response = await fetchFn(url);
  } catch (e) {
    return { ok: false, error: `rete: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!response.ok) return { ok: false, error: response.status === 404 ? "indice pubblicato assente" : `HTTP ${response.status}` };
  let data: unknown;
  try {
    data = JSON.parse(await response.text());
  } catch {
    return { ok: false, error: "indice pubblicato non leggibile (JSON non valido)" };
  }
  const bundles = (data as { bundles?: unknown } | null)?.bundles;
  if (!Array.isArray(bundles)) return { ok: false, error: "indice pubblicato con una forma inattesa" };
  return { ok: true, entries: bundles as BundleIndexEntry[] };
}

/**
 * Indice che vedono l'app e il server: i bundle dei file, sostituiti da quelli pubblicati. Senza indice
 * pubblicato restano solo i bundle dei file, che non hanno mai contenuti a pagamento (lib/static-bundles.ts):
 * le destinazioni gestite solo dallo Studio risultano «temporaneamente non disponibili», non «gratuite».
 */
export function combineIndexes(staticEntries: BundleIndexEntry[], published: PublishedIndexResult): { entries: BundleIndexEntry[]; publishedOk: boolean } {
  return { entries: mergeIndexes(staticEntries, published.ok ? published.entries : null), publishedOk: published.ok };
}

/** Voce per una destinazione e lingua; «unavailable» se manca e l'indice pubblicato non si è potuto leggere. */
export function findEntry(
  index: { entries: BundleIndexEntry[]; publishedOk: boolean },
  destination: string,
  locale: string,
): { entry: BundleIndexEntry } | { unavailable: true } | { unknown: true } {
  const entry = index.entries.find((b) => b.destination === destination && b.locale === locale);
  if (entry) return { entry };
  return index.publishedOk ? { unknown: true } : { unavailable: true };
}

/**
 * Indice dell'app: bundle dei file più bundle pubblicati (`pubUrl` null: Supabase non configurato).
 * Senza nessuno dei due è un errore; senza l'indice pubblicato restano i bundle dei file e `publishedOk` è falso.
 */
export async function loadIndexes(
  fetchFn: (url: string) => Promise<Response>,
  staticUrl: string,
  pubUrl: string | null,
): Promise<{ entries: BundleIndexEntry[]; publishedOk: boolean }> {
  const [statics, published] = await Promise.all([
    fetchFn(staticUrl)
      .then(async (r) => (r.ok ? ((JSON.parse(await r.text()) as BundleIndex).bundles ?? null) : null))
      .catch(() => null),
    pubUrl ? fetchPublishedIndex(fetchFn, pubUrl) : Promise.resolve<PublishedIndexResult>({ ok: true, entries: [] }),
  ]);
  if (!Array.isArray(statics) && !published.ok) throw new Error(published.error);
  return combineIndexes(Array.isArray(statics) ? statics : [], published);
}
