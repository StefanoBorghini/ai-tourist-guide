/**
 * Scheda «Eventi» dello Studio: etichette e lettura del modulo. Logica pura, testata.
 *
 * Il modulo si controlla qui per dare messaggi chiari prima di scrivere; la decisione resta al database
 * (migrazione 20261031000000: vincoli, trigger e funzioni studio_*_local_event), che ripete ogni controllo.
 * Gli indirizzi si salvano nella forma normalizzata di safeHttpsUrl, la stessa che il database accetta.
 */
import { isIsoDate, isLocalTime, isValidTimeZone, localDate, localTime, safeHttpsUrl } from "../local-events";

export const EVENT_CATEGORIES = [
  "culture", "music", "exhibitions", "food_wine", "fairs_markets", "excursions", "outdoor", "local_initiatives", "other",
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<EventCategory, string> = {
  culture: "Cultura e spettacoli",
  music: "Concerti e musica",
  exhibitions: "Mostre ed esposizioni",
  food_wine: "Enogastronomia e degustazioni",
  fairs_markets: "Feste, sagre e mercatini",
  excursions: "Escursioni organizzate",
  outdoor: "Attività all'aperto",
  local_initiatives: "Iniziative locali",
  other: "Altro",
};

export const EVENT_STATUSES = ["scheduled", "unconfirmed", "cancelled", "postponed"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  scheduled: "Previsto",
  unconfirmed: "Da confermare",
  cancelled: "Annullato",
  postponed: "Rinviato",
};

export const PUBLICATION_LABELS: Record<string, string> = {
  draft: "Bozza",
  published: "Pubblicato",
  withdrawn: "Ritirato",
};

export const PRICES = ["free", "paid", "unknown"] as const;
export const PRICE_LABELS: Record<(typeof PRICES)[number], string> = {
  free: "Gratuito",
  paid: "A pagamento",
  unknown: "Da verificare",
};

/** Evento come lo restituiscono le funzioni dello Studio (studio_local_event_json). */
export interface StudioEvent {
  id: string;
  pack: string;
  slug: string;
  labels: Record<string, { title?: string; summary?: string; description?: string }>;
  category: EventCategory;
  startDate: string;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
  startsAt: string;
  endsAt: string;
  place: string | null;
  venueName: string;
  venueAddress: string | null;
  lat: number | null;
  lng: number | null;
  organizer: string | null;
  sourceUrl: string | null;
  infoUrl: string | null;
  bookingUrl: string | null;
  price: (typeof PRICES)[number];
  priceNote: string | null;
  languages: string[];
  seriesId: string | null;
  status: EventStatus;
  statusNote: string | null;
  publication: "draft" | "published" | "withdrawn";
  verifiedAt: string | null;
  verifiedBy: string | null;
  verificationNote: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export type FormValues = Record<string, string>;
export type EventPayload = Record<string, unknown>;
export type ParseResult = { ok: true; payload: EventPayload } | { ok: false; error: string };

const URL_FIELDS = [
  ["sourceUrl", "L'indirizzo della fonte ufficiale"],
  ["infoUrl", "L'indirizzo per informazioni"],
  ["bookingUrl", "L'indirizzo di prenotazione"],
] as const;

/** Lunghezze massime, le stesse dei vincoli della tabella local_events. */
const TEXT_LIMITS = [
  ["venueName", "Nome del luogo dell'evento", 160],
  ["venueAddress", "Indirizzo", 240],
  ["organizer", "Organizzatore", 160],
  ["priceNote", "Nota sul prezzo", 160],
  ["statusNote", "Nota sullo stato", 300],
] as const;
const LABEL_LIMITS = [
  ["title", "Titolo", 140],
  ["summary", "Descrizione breve", 300],
  ["description", "Descrizione", 4000],
] as const;

/**
 * Dati del modulo → oggetto per studio_save_local_event. `locales` sono le lingue del territorio (la prima è la
 * principale); i testi stanno nei campi `title_<lingua>`, `summary_<lingua>`, `description_<lingua>`.
 */
export function eventPayloadFromForm(v: FormValues, locales: readonly string[], defaultLocale: string): ParseResult {
  const get = (k: string) => (v[k] ?? "").trim();
  const labels: Record<string, Record<string, string>> = {};
  for (const l of locales) {
    const entry: Record<string, string> = {};
    for (const field of ["title", "summary", "description"] as const) {
      const value = get(`${field}_${l}`);
      if (value) entry[field] = value;
    }
    if (Object.keys(entry).length > 0) labels[l] = entry;
  }
  if (!labels[defaultLocale]?.title) return { ok: false, error: `Manca il titolo in ${defaultLocale.toUpperCase()} (lingua principale del territorio).` };
  const category = get("category");
  if (!(EVENT_CATEGORIES as readonly string[]).includes(category)) return { ok: false, error: "Scegli la categoria." };

  const startDate = get("startDate");
  const startTime = get("startTime") || null;
  const endDate = get("endDate") || null;
  const endTime = get("endTime") || null;
  if (!isIsoDate(startDate)) return { ok: false, error: "Indica la data di inizio." };
  if (endDate !== null && !isIsoDate(endDate)) return { ok: false, error: "La data di fine non è valida." };
  if ((startTime !== null && !isLocalTime(startTime)) || (endTime !== null && !isLocalTime(endTime))) {
    return { ok: false, error: "Gli orari si scrivono come 21:00." };
  }
  if (endTime !== null && startTime === null) return { ok: false, error: "Un orario di fine richiede anche l'orario di inizio." };

  const venueName = get("venueName");
  const place = get("place") || null;
  if (!venueName) return { ok: false, error: "Indica il nome del luogo dell'evento (anche se scegli un luogo del territorio)." };

  const latRaw = get("lat");
  const lngRaw = get("lng");
  if ((latRaw === "") !== (lngRaw === "")) return { ok: false, error: "Per le coordinate servono latitudine e longitudine." };
  const lat = latRaw === "" ? null : Number(latRaw.replace(",", "."));
  const lng = lngRaw === "" ? null : Number(lngRaw.replace(",", "."));
  if (lat !== null && (!Number.isFinite(lat) || !Number.isFinite(lng!) || Math.abs(lat) > 90 || Math.abs(lng!) > 180)) {
    return { ok: false, error: "Coordinate non valide (es. 44.0505 e 9.8357)." };
  }

  const urls: Record<string, string | null> = {};
  for (const [field, label] of URL_FIELDS) {
    const raw = get(field);
    if (!raw) {
      urls[field] = null;
      continue;
    }
    const safe = safeHttpsUrl(raw);
    if (!safe) return { ok: false, error: `${label} deve essere completo e iniziare con https:// (senza spazi né credenziali).` };
    urls[field] = safe;
  }

  const price = get("price") || "unknown";
  if (!(PRICES as readonly string[]).includes(price)) return { ok: false, error: "Prezzo non riconosciuto." };
  const status = get("status") || "scheduled";
  if (!(EVENT_STATUSES as readonly string[]).includes(status)) return { ok: false, error: "Stato dell'evento non riconosciuto." };
  const languages = [...new Set((v.languages ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (languages.some((s) => !/^[a-z]{2}$/.test(s)) || languages.length > 10) {
    return { ok: false, error: "Lingue dell'evento: codici di due lettere separati da virgole (es. it, en), al massimo 10." };
  }
  const slug = get("slug");
  if (slug && (slug.length > 80 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug))) {
    return { ok: false, error: "L'identificativo usa solo lettere minuscole, cifre e trattini (al massimo 80 caratteri)." };
  }
  for (const [field, label, max] of TEXT_LIMITS) {
    if (get(field).length > max) return { ok: false, error: `${label}: al massimo ${max} caratteri.` };
  }
  for (const [l, entry] of Object.entries(labels)) {
    for (const [field, label, max] of LABEL_LIMITS) {
      if ((entry[field]?.length ?? 0) > max) return { ok: false, error: `${label} (${l}): al massimo ${max} caratteri.` };
    }
  }

  return {
    ok: true,
    payload: {
      ...(get("slug") ? { slug: get("slug") } : {}),
      labels,
      category,
      startDate,
      startTime,
      endDate,
      endTime,
      place,
      venueName,
      venueAddress: get("venueAddress") || null,
      lat,
      lng,
      organizer: get("organizer") || null,
      ...urls,
      price,
      priceNote: get("priceNote") || null,
      languages,
      status,
      statusNote: get("statusNote") || null,
    },
  };
}

/** «21 ottobre 2026, 21:00 → 22 ottobre, 02:00», «… · orario da confermare»: date e ore locali del territorio. */
export function eventWhen(e: Pick<StudioEvent, "startDate" | "startTime" | "endDate" | "endTime">): string {
  const day = (d: string) => {
    const [y, m, dd] = d.split("-").map(Number) as [number, number, number];
    return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  };
  const start = `${day(e.startDate)}${e.startTime ? `, ${e.startTime}` : " · orario da confermare"}`;
  if (!e.endDate || (e.endDate === e.startDate && !e.endTime)) return start;
  if (e.endDate === e.startDate) return `${start}–${e.endTime}`;
  return `${start} → ${day(e.endDate)}${e.endTime ? `, ${e.endTime}` : ""}`;
}

/** Cosa manca per pubblicare, in parole semplici (vuoto = si può pubblicare). */
export function publishBlockers(e: Pick<StudioEvent, "sourceUrl" | "verifiedAt" | "endsAt">, now: number = Date.now()): string[] {
  const out: string[] = [];
  if (!e.sourceUrl) out.push("manca l'indirizzo della fonte ufficiale");
  else if (!e.verifiedAt) out.push("la fonte non è ancora stata verificata");
  if (Date.parse(e.endsAt) <= now) out.push("l'evento è già concluso");
  return out;
}

/** Viste dell'elenco: in arrivo (non conclusi, non ritirati), per stato di pubblicazione, conclusi. */
export const EVENT_VIEWS = ["prossimi", "bozze", "pubblicati", "ritirati", "passati"] as const;
export type EventView = (typeof EVENT_VIEWS)[number];
export const EVENT_VIEW_LABELS: Record<EventView, string> = {
  prossimi: "In arrivo",
  bozze: "Bozze",
  pubblicati: "Pubblicati",
  ritirati: "Ritirati",
  passati: "Conclusi",
};
export const isEventView = (v: string | undefined): v is EventView => (EVENT_VIEWS as readonly string[]).includes(v ?? "");

export function inView(e: Pick<StudioEvent, "publication" | "endsAt">, view: EventView, now: number = Date.now()): boolean {
  const over = Date.parse(e.endsAt) <= now;
  switch (view) {
    case "prossimi": return !over && e.publication !== "withdrawn";
    case "bozze": return e.publication === "draft";
    case "pubblicati": return !over && e.publication === "published";
    case "ritirati": return e.publication === "withdrawn";
    case "passati": return over;
  }
}

/** Evento → valori iniziali del modulo (stessi nomi dei campi letti da eventPayloadFromForm). */
export function formValuesFromEvent(e: StudioEvent, locales: readonly string[]): FormValues {
  const v: FormValues = {
    category: e.category,
    startDate: e.startDate,
    startTime: e.startTime ?? "",
    endDate: e.endDate ?? "",
    endTime: e.endTime ?? "",
    place: e.place ?? "",
    venueName: e.venueName,
    venueAddress: e.venueAddress ?? "",
    lat: e.lat === null ? "" : String(e.lat),
    lng: e.lng === null ? "" : String(e.lng),
    organizer: e.organizer ?? "",
    sourceUrl: e.sourceUrl ?? "",
    infoUrl: e.infoUrl ?? "",
    bookingUrl: e.bookingUrl ?? "",
    price: e.price,
    priceNote: e.priceNote ?? "",
    languages: e.languages.join(", "),
    status: e.status,
    statusNote: e.statusNote ?? "",
  };
  for (const l of locales) {
    v[`title_${l}`] = e.labels[l]?.title ?? "";
    v[`summary_${l}`] = e.labels[l]?.summary ?? "";
    v[`description_${l}`] = e.labels[l]?.description ?? "";
  }
  return v;
}

/** Titolo da mostrare: lingua principale, poi la prima disponibile, poi l'identificativo. */
export function eventTitle(e: Pick<StudioEvent, "labels" | "slug">, defaultLocale: string): string {
  return e.labels[defaultLocale]?.title ?? Object.values(e.labels).find((l) => l?.title)?.title ?? e.slug;
}

/** Istante (verifica, pubblicazione) come data e ora locali del territorio: «2026-10-20 18:05». */
export function formatStamp(iso: string | null, tz: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const zone = isValidTimeZone(tz) ? tz : "UTC";
  return `${localDate(t, zone)} ${localTime(t, zone)}`;
}
