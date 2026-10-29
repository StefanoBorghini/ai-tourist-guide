/**
 * Directory delle attività locali nella guida: lettura della risposta di `GET /api/v1/businesses`, filtri, ordine e
 * collegamenti. Logica pura, testata; il componente `BusinessesPanel` la mostra.
 *
 * Gratuita e neutrale (docs/v0.3-platform/DIRECTORY-ATTIVITA-LOCALI.md): nessun badge, nessuna priorità. L'ordine è
 * quello alfabetico del database oppure, se si conosce la posizione del visitatore, per distanza (a parità di
 * distanza resta l'alfabetico). Solo online: non entra nei bundle, nel pacchetto offline né nelle risposte dell'AI.
 * Gli orari si mostrano solo se la verifica è recente (D15: entro 180 giorni), altrimenti «orari da verificare».
 */
import { distanceM } from "@guide/context-engine";
import { safeHttpsUrl } from "./local-events";
import type { LngLat } from "./map-view";

export const BUSINESS_CATEGORY_IDS = ["restaurant", "bar", "shop", "accommodation", "tourist_service", "other"] as const;
export type BusinessCategoryId = (typeof BUSINESS_CATEGORY_IDS)[number];

/** Oltre questa età della verifica gli orari non si mostrano (possono essere cambiati). */
export const HOURS_FRESH_DAYS = 180;

export interface PublicBusiness {
  id: string;
  name: string;
  category: BusinessCategoryId;
  subcategory: string | null;
  description: string | null;
  hours: string | null;
  address: string | null;
  location: LngLat | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  verifiedAt: string | null;
  /** Foto con i crediti, nell'ordine scelto dalla redazione (la prima è la copertina). */
  photos: BusinessPhoto[];
}

export interface BusinessPhoto {
  url: string;
  alt: string;
  /** «Mario Rossi · CC BY 4.0»: autore e, per le licenze che lo chiedono, il nome della licenza. */
  credit: string | null;
  originalUrl: string | null;
}

/** Licenze che chiedono di essere citate accanto all'autore. */
const LICENSE_CREDIT: Record<string, string> = {
  "cc-by-4.0": "CC BY 4.0",
  "cc-by-sa-4.0": "CC BY-SA 4.0",
  "cc-by-nc-4.0": "CC BY-NC 4.0",
  "cc-by-nc-sa-4.0": "CC BY-NC-SA 4.0",
};
const MAX_PHOTOS = 6;

export interface BusinessesData {
  territory: string;
  businesses: PublicBusiness[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const PHONE_RE = /^\+?[0-9][0-9 ./()-]{4,38}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Indirizzo dell'immagine: https, oppure http solo in locale (prove). */
function photoSrc(v: unknown): string | null {
  const u = str(v);
  if (!u || u.length > 600) return null;
  return /^https:\/\/[^\s"'<>]+$/.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s"'<>]+$/.test(u) ? u : null;
}

function parsePhoto(raw: unknown): BusinessPhoto | null {
  const p = obj(raw);
  const url = photoSrc(p.url);
  const alt = str(p.alt);
  if (!url || !alt) return null;
  const author = str(p.author);
  const license = str(p.license);
  const credit = [author, license ? LICENSE_CREDIT[license] : undefined].filter(Boolean).join(" · ");
  return { url, alt, credit: credit || null, originalUrl: safeHttpsUrl(p.originalUrl) };
}

function parseBusiness(raw: unknown): PublicBusiness | null {
  const b = obj(raw);
  const id = str(b.id);
  const name = str(b.name);
  if (!id || !name) return null;
  const lat = num(b.lat);
  const lng = num(b.lng);
  const phone = str(b.phone);
  const email = str(b.email);
  return {
    id,
    name,
    category: (BUSINESS_CATEGORY_IDS as readonly string[]).includes(b.category as string) ? (b.category as BusinessCategoryId) : "other",
    subcategory: str(b.subcategory),
    description: str(b.description),
    hours: str(b.hours),
    address: str(b.address),
    location: lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lng, lat] : null,
    // Ricontrollati anche se il database li ha accettati: un collegamento che non passa non si mostra.
    phone: phone && PHONE_RE.test(phone) ? phone : null,
    email: email && EMAIL_RE.test(email) ? email : null,
    website: safeHttpsUrl(b.website),
    verifiedAt: str(b.verifiedAt),
    photos: (Array.isArray(b.photos) ? b.photos : []).map(parsePhoto).filter((f): f is BusinessPhoto => f !== null).slice(0, MAX_PHOTOS),
  };
}

/** Risposta dell'API → dati utilizzabili; null se la forma non è quella attesa. Le attività malformate si scartano. */
export function parseBusinessesData(json: unknown): BusinessesData | null {
  const d = obj(json);
  const id = str(obj(d.territory).id);
  if (!id || !Array.isArray(d.businesses)) return null;
  return { territory: id, businesses: d.businesses.map(parseBusiness).filter((b): b is PublicBusiness => b !== null) };
}

export function businessesUrl(territory: string, lang: string | null): string {
  const q = new URLSearchParams({ territory });
  if (lang) q.set("lang", lang);
  return `/api/v1/businesses?${q.toString()}`;
}

/** Come per gli eventi: `unavailable` = nessuna directory per questo territorio o servizio spento (non si mostra nulla). */
export type BusinessesState =
  | { kind: "loading" }
  | { kind: "offline" }
  | { kind: "unavailable" }
  | { kind: "error" }
  | { kind: "ok"; data: BusinessesData };

export function businessesStateFromResponse(status: number, json: unknown): BusinessesState {
  if (status === 200) {
    const data = parseBusinessesData(json);
    if (!data) return { kind: "error" };
    // Directory vuota: come se non ci fosse (niente riquadro vuoto nella visita).
    return data.businesses.length > 0 ? { kind: "ok", data } : { kind: "unavailable" };
  }
  if (status === 404 || (status === 503 && obj(json).error === "non_configurato")) return { kind: "unavailable" };
  return { kind: "error" };
}

/** Categorie presenti, nell'ordine fisso del vocabolario (per i filtri). */
export function businessCategoriesIn(list: readonly PublicBusiness[]): BusinessCategoryId[] {
  const present = new Set(list.map((b) => b.category));
  return BUSINESS_CATEGORY_IDS.filter((c) => present.has(c));
}

export interface ListedBusiness {
  business: PublicBusiness;
  /** Metri dalla posizione del visitatore; null se non si conosce l'una o l'altra posizione. */
  distanceM: number | null;
}

/**
 * Elenco da mostrare: filtrato per categoria e, se c'è la posizione, ordinato per distanza (prima quelle con le
 * coordinate, a parità di distanza l'ordine alfabetico del database). Senza posizione resta l'ordine alfabetico.
 */
export function listBusinesses(data: BusinessesData, category: BusinessCategoryId | null, here: LngLat | null): ListedBusiness[] {
  const rows = data.businesses
    .filter((b) => category === null || b.category === category)
    .map((business, index) => ({ business, index, distanceM: here && business.location ? distanceM(here, business.location) : null }));
  if (here) {
    rows.sort((a, b) => {
      if (a.distanceM === null || b.distanceM === null) return a.distanceM === null ? (b.distanceM === null ? a.index - b.index : 1) : -1;
      return a.distanceM - b.distanceM || a.index - b.index;
    });
  }
  return rows.map(({ business, distanceM: d }) => ({ business, distanceM: d }));
}

/** Gli orari valgono solo se la verifica è recente. */
export function hoursFresh(verifiedAt: string | null, now: number, days: number = HOURS_FRESH_DAYS): boolean {
  if (!verifiedAt) return false;
  const t = Date.parse(verifiedAt);
  return Number.isFinite(t) && t <= now + 60_000 && now - t <= days * 86_400_000;
}

/** «120 m», «1,4 km» (in linea d'aria). */
export function distanceLabel(m: number, locale: string): string {
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} km`;
}

/** Numero da chiamare: solo cifre e il + iniziale. */
export const telHref = (phone: string) => `tel:${phone.replace(/[^0-9+]/g, "")}`;

/** Data di verifica leggibile («28 ottobre 2026»); null se mancante o non valida. */
export function businessVerifiedDate(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
}

/**
 * Segni per la mappa del livello «Locali e attività»: le attività dell'elenco (già filtrate) che hanno coordinate.
 * Le altre restano solo nell'elenco: non si inventa una posizione.
 */
export function venueMarkers(rows: readonly ListedBusiness[]): { id: string; name: string; location: LngLat; category: BusinessCategoryId }[] {
  return rows.flatMap(({ business: b }) => (b.location ? [{ id: b.id, name: b.name, location: b.location, category: b.category }] : []));
}

/** Modalità di esplorazione della visita: i luoghi del territorio o la directory delle attività. */
export type ExploreTheme = "culture" | "venues";
export const EXPLORE_THEMES: readonly ExploreTheme[] = ["culture", "venues"];
export const parseExploreTheme = (v: unknown): ExploreTheme => (v === "venues" ? "venues" : "culture");
