/**
 * Consegna dei contenuti acquistati: regole pure condivise da /api/premium e dall'app (test in test/premium.test.ts).
 * - Il server firma per pochi minuti solo i file a pagamento che le policy del bucket «premium» lasciano leggere
 *   all'utente (migrazione 20261027000000): il diritto lo decide il database, non questo codice.
 * - L'app conserva le parti scaricate con una scadenza: usabili senza rete per 30 giorni dall'ultima convalida
 *   online; a ogni convalida si tengono solo quelle che il server concede ancora (rimborso o revoca: si cancellano).
 *   Non è un sistema anti-copia: un dispositivo che resta offline conserva la copia fino alla scadenza.
 */
import type { BundleManifest, PremiumFile } from "@guide/bundle/client";

/** Bucket privato dei contenuti a pagamento (migrazione 20261027000000_premium_storage.sql). */
export const PREMIUM_BUCKET = "premium";
export const PREMIUM_OFFLINE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Durata degli indirizzi firmati: il tempo di scaricare. */
export const SIGNED_URL_SECONDS = 300;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PACK = "[a-z0-9]+(?:-[a-z0-9]+)*(?:\\.[a-z0-9]+(?:-[a-z0-9]+)*)*";
const MANIFEST_URL = new RegExp(`^/pub/(${PACK})/([a-z]{2})-full/(${UUID})/manifest\\.json$`);

export interface PremiumTarget {
  pack: string;
  locale: string;
  publication: string;
}

/** Il manifest pubblicato a cui si riferisce la richiesta (solo quelli di una pubblicazione dello Studio). */
export function premiumTarget(manifestUrl: string | null | undefined): PremiumTarget | null {
  const m = manifestUrl ? MANIFEST_URL.exec(manifestUrl) : null;
  return m ? { pack: m[1]!, locale: m[2]!, publication: m[3]! } : null;
}

/** File a pagamento elencati dal manifest, solo quelli della sua cartella (un manifest altrui non allarga nulla). */
export function premiumEntries(manifest: Pick<BundleManifest, "destination" | "locale" | "premium">, target: PremiumTarget): PremiumFile[] {
  if (manifest.destination !== target.pack || manifest.locale !== target.locale) return [];
  const prefix = `${target.pack}/${target.locale}/${target.publication}/`;
  return (manifest.premium ?? []).filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes("/"));
}

/** Risposta di /api/premium. */
export interface PremiumGrant {
  enabled: boolean;
  signedIn: boolean;
  /** Parti che l'utente può scaricare ora, con indirizzi firmati brevi. */
  parts: { entry: PremiumFile; url: string }[];
  /** Fino a quando le parti si usano senza rete (millisecondi). */
  validUntil: number | null;
}

export const offlineUntil = (now: number) => now + PREMIUM_OFFLINE_DAYS * DAY_MS;

/** Copia sul dispositivo delle parti acquistate di un bundle. */
export interface StoredPremium {
  manifest: string;
  validUntil: number;
  parts: { entry: PremiumFile; json: string }[];
}

/** Parti usabili ora: solo per questo manifest e non scadute. */
export function usableParts(stored: StoredPremium | null, manifestUrl: string, now: number): StoredPremium["parts"] {
  if (!stored || stored.manifest !== manifestUrl || stored.validUntil <= now) return [];
  return stored.parts;
}

/**
 * Dopo una convalida online: si tengono solo le parti che il server concede ancora (le altre si cancellano:
 * rimborso, revoca, scadenza del diritto) e la scadenza offline riparte.
 */
export function reconcile(stored: StoredPremium | null, manifestUrl: string, allowed: readonly PremiumFile[], validUntil: number): StoredPremium {
  const keep = new Set(allowed.map((f) => `${f.path}|${f.sha256}`));
  const parts = stored?.manifest === manifestUrl ? stored.parts.filter((p) => keep.has(`${p.entry.path}|${p.entry.sha256}`)) : [];
  return { manifest: manifestUrl, validUntil, parts };
}

/** Parti concesse che il dispositivo non ha ancora (da scaricare). */
export function missingParts(stored: StoredPremium, allowed: readonly PremiumFile[]): PremiumFile[] {
  const have = new Set(stored.parts.map((p) => `${p.entry.path}|${p.entry.sha256}`));
  return allowed.filter((f) => !have.has(`${f.path}|${f.sha256}`));
}
