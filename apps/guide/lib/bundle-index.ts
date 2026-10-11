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
