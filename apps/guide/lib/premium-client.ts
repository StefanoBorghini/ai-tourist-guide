/**
 * Contenuti acquistati sul dispositivo: copia locale con scadenza (lib/premium.ts) e convalida online da
 * /api/premium. Ogni parte si verifica con l'impronta del manifest a ogni uso, non solo allo scaricamento.
 */
import { verifyPremiumPart, type PremiumPart } from "@guide/bundle/client";
import { missingParts, reconcile, usableParts, type PremiumGrant, type StoredPremium } from "./premium";

const KEY_PREFIX = "guide-premium:";
const keyOf = (manifestUrl: string) => KEY_PREFIX + manifestUrl.replace(/\/[0-9a-f-]{36}\/manifest\.json$/, "");

function read(manifestUrl: string): StoredPremium | null {
  try {
    const raw = localStorage.getItem(keyOf(manifestUrl));
    return raw ? (JSON.parse(raw) as StoredPremium) : null;
  } catch {
    return null;
  }
}

function write(stored: StoredPremium) {
  try {
    if (stored.parts.length === 0) localStorage.removeItem(keyOf(stored.manifest));
    else localStorage.setItem(keyOf(stored.manifest), JSON.stringify(stored));
  } catch {
    // Spazio pieno o archiviazione non disponibile: le parti valgono solo finché la pagina resta aperta.
  }
}

async function verified(parts: StoredPremium["parts"]): Promise<PremiumPart[]> {
  const out: PremiumPart[] = [];
  for (const p of parts) {
    try {
      out.push(await verifyPremiumPart(p.entry, p.json));
    } catch {
      // Copia alterata: si ignora (alla prossima convalida si riscarica).
    }
  }
  return out;
}

/** Parti acquistate già sul dispositivo e ancora valide per questo bundle. */
export async function localPremium(manifestUrl: string, now = Date.now()): Promise<PremiumPart[]> {
  return verified(usableParts(read(manifestUrl), manifestUrl, now));
}

/**
 * Convalida online: chiede al server cosa l'utente ha acquistato, cancella ciò che non è più concesso, scarica ciò
 * che manca. null = acquisti spenti o utente non entrato (la copia locale resta fino alla sua scadenza).
 */
export async function syncPremium(manifestUrl: string): Promise<PremiumPart[] | null> {
  const res = await fetch(`/api/premium?manifest=${encodeURIComponent(manifestUrl)}`, { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) return null;
  const grant = (await res.json()) as PremiumGrant;
  if (!grant.enabled || !grant.signedIn || grant.validUntil === null) return null;
  const allowed = grant.parts.map((p) => p.entry);
  const next = reconcile(read(manifestUrl), manifestUrl, allowed, grant.validUntil);
  for (const entry of missingParts(next, allowed)) {
    const url = grant.parts.find((p) => p.entry.path === entry.path)!.url;
    try {
      const json = await (await fetch(url, { cache: "no-store" })).text();
      await verifyPremiumPart(entry, json);
      next.parts.push({ entry, json });
    } catch {
      // Scaricamento non riuscito: si riprova alla prossima apertura.
    }
  }
  write(next);
  return verified(next.parts);
}
