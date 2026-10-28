/**
 * Scheda «Attività» dello Studio (directory gratuita): etichette e lettura del modulo. Logica pura, testata.
 *
 * Il modulo si controlla qui per dare messaggi chiari prima di scrivere; la decisione resta al database
 * (migrazione 20261105000000: vincoli, trigger e funzioni studio_*_local_business), che ripete ogni controllo.
 * Nessun campo di affiliazione o priorità: la directory tratta tutte le attività allo stesso modo.
 */
import { safeHttpsUrl } from "../local-events";

export const BUSINESS_CATEGORIES = ["restaurant", "bar", "shop", "accommodation", "tourist_service", "other"] as const;
export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];

export const BUSINESS_CATEGORY_LABELS: Record<BusinessCategory, string> = {
  restaurant: "Ristoranti, trattorie e pizzerie",
  bar: "Bar, caffè, enoteche, gelaterie e locali",
  shop: "Negozi e botteghe artigiane",
  accommodation: "Strutture ricettive",
  tourist_service: "Servizi turistici e attività ricreative",
  other: "Altro",
};

export const BUSINESS_PUBLICATION_LABELS: Record<string, string> = {
  draft: "Bozza",
  published: "Pubblicata",
  withdrawn: "Ritirata",
};

/** Attività come la restituiscono le funzioni dello Studio (studio_local_business_json). */
export interface StudioBusiness {
  id: string;
  pack: string;
  slug: string;
  name: string;
  category: BusinessCategory;
  subcategory: string | null;
  labels: Record<string, { description?: string; hours?: string }>;
  address: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  publication: "draft" | "published" | "withdrawn";
  verifiedAt: string | null;
  verifiedBy: string | null;
  verificationNote: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export type FormValues = Record<string, string>;
export type BusinessParseResult = { ok: true; payload: Record<string, unknown> } | { ok: false; error: string };

const PHONE_RE = /^\+?[0-9][0-9 ./()-]{4,38}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Dati del modulo → oggetto per studio_save_local_business. Testi per lingua in `description_<l>` e `hours_<l>`. */
export function businessPayloadFromForm(v: FormValues, locales: readonly string[]): BusinessParseResult {
  const get = (k: string) => (v[k] ?? "").trim();
  const name = get("name");
  if (!name) return { ok: false, error: "Indica il nome dell'attività." };
  if (name.length > 120) return { ok: false, error: "Nome: al massimo 120 caratteri." };
  const category = get("category");
  if (!(BUSINESS_CATEGORIES as readonly string[]).includes(category)) return { ok: false, error: "Scegli la categoria." };
  const subcategory = get("subcategory");
  if (subcategory.length > 60) return { ok: false, error: "Tipo (es. pizzeria): al massimo 60 caratteri." };

  const labels: Record<string, Record<string, string>> = {};
  for (const l of locales) {
    const description = get(`description_${l}`);
    const hours = get(`hours_${l}`);
    if (description.length > 1000) return { ok: false, error: `Descrizione (${l}): al massimo 1000 caratteri.` };
    if (hours.length > 300) return { ok: false, error: `Orari (${l}): al massimo 300 caratteri.` };
    const entry: Record<string, string> = {};
    if (description) entry.description = description;
    if (hours) entry.hours = hours;
    if (Object.keys(entry).length > 0) labels[l] = entry;
  }

  const address = get("address");
  if (address.length > 240) return { ok: false, error: "Indirizzo: al massimo 240 caratteri." };
  const latRaw = get("lat");
  const lngRaw = get("lng");
  if ((latRaw === "") !== (lngRaw === "")) return { ok: false, error: "Per le coordinate servono latitudine e longitudine." };
  const lat = latRaw === "" ? null : Number(latRaw.replace(",", "."));
  const lng = lngRaw === "" ? null : Number(lngRaw.replace(",", "."));
  if (lat !== null && (!Number.isFinite(lat) || !Number.isFinite(lng!) || Math.abs(lat) > 90 || Math.abs(lng!) > 180)) {
    return { ok: false, error: "Coordinate non valide (es. 44.0505 e 9.8357)." };
  }
  const phone = get("phone");
  if (phone && !PHONE_RE.test(phone)) return { ok: false, error: "Telefono: solo cifre, spazi e il + iniziale (es. +39 0187 790000)." };
  const email = get("email");
  if (email && (email.length > 160 || !EMAIL_RE.test(email))) return { ok: false, error: "Email non valida." };
  const websiteRaw = get("website");
  const website = websiteRaw ? safeHttpsUrl(websiteRaw) : null;
  if (websiteRaw && !website) return { ok: false, error: "Il sito deve essere completo e iniziare con https:// (senza spazi né credenziali)." };
  const slug = get("slug");
  if (slug && (slug.length > 80 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug))) {
    return { ok: false, error: "L'identificativo usa solo lettere minuscole, cifre e trattini (al massimo 80 caratteri)." };
  }
  return {
    ok: true,
    payload: {
      ...(slug ? { slug } : {}),
      name,
      category,
      subcategory: subcategory || null,
      labels,
      address: address || null,
      lat,
      lng,
      phone: phone || null,
      email: email || null,
      website,
    },
  };
}

/** Attività → valori iniziali del modulo (stessi nomi dei campi letti da businessPayloadFromForm). */
export function formValuesFromBusiness(b: StudioBusiness, locales: readonly string[]): FormValues {
  const v: FormValues = {
    name: b.name,
    category: b.category,
    subcategory: b.subcategory ?? "",
    address: b.address ?? "",
    lat: b.lat === null ? "" : String(b.lat),
    lng: b.lng === null ? "" : String(b.lng),
    phone: b.phone ?? "",
    email: b.email ?? "",
    website: b.website ?? "",
  };
  for (const l of locales) {
    v[`description_${l}`] = b.labels[l]?.description ?? "";
    v[`hours_${l}`] = b.labels[l]?.hours ?? "";
  }
  return v;
}

/** Viste dell'elenco dello Studio. */
export const BUSINESS_VIEWS = ["tutte", "bozze", "pubblicate", "ritirate", "da-riverificare"] as const;
export type BusinessView = (typeof BUSINESS_VIEWS)[number];
export const BUSINESS_VIEW_LABELS: Record<BusinessView, string> = {
  tutte: "Tutte",
  bozze: "Bozze",
  pubblicate: "Pubblicate",
  ritirate: "Ritirate",
  "da-riverificare": "Da riverificare",
};
export const isBusinessView = (v: string | undefined): v is BusinessView => (BUSINESS_VIEWS as readonly string[]).includes(v ?? "");

/** Oltre 180 giorni dalla verifica la guida nasconde gli orari: la redazione le riverifica (D15). */
export const REVERIFY_DAYS = 180;
export function needsReverify(b: Pick<StudioBusiness, "verifiedAt">, now: number = Date.now()): boolean {
  if (!b.verifiedAt) return true;
  const t = Date.parse(b.verifiedAt);
  return !Number.isFinite(t) || now - t > REVERIFY_DAYS * 86_400_000;
}

export function inBusinessView(b: Pick<StudioBusiness, "publication" | "verifiedAt">, view: BusinessView, now: number = Date.now()): boolean {
  switch (view) {
    case "tutte": return true;
    case "bozze": return b.publication === "draft";
    case "pubblicate": return b.publication === "published";
    case "ritirate": return b.publication === "withdrawn";
    case "da-riverificare": return b.publication === "published" && needsReverify(b, now);
  }
}
