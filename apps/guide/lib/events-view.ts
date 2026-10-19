/**
 * Eventi del giorno nella guida: lettura della risposta di `GET /api/v1/events`, viste Oggi / Domani / 7 giorni,
 * filtri ed etichette. Logica pura, testata; il componente `EventsPanel` la mostra.
 *
 * Dati operativi, solo online: non entrano nei bundle, nel pacchetto offline né nelle risposte dell'AI. «Oggi» è
 * quello del territorio (`today` dell'API), non quello del telefono. Gli indirizzi si ricontrollano qui con
 * safeHttpsUrl anche se il database li ha già accettati: un link che non passa non si mostra.
 */
import { addDays, eventsByDay, isIsoDate, isValidTimeZone, localDate, safeHttpsUrl } from "./local-events";

export const EVENT_CATEGORY_IDS = [
  "culture", "music", "exhibitions", "food_wine", "fairs_markets", "excursions", "outdoor", "local_initiatives", "other",
] as const;
export type EventCategoryId = (typeof EVENT_CATEGORY_IDS)[number];
export type EventStatusId = "scheduled" | "unconfirmed" | "cancelled" | "postponed";
export type PriceKind = "free" | "paid" | "unknown";

export interface PublicEvent {
  id: string;
  category: EventCategoryId;
  status: EventStatusId;
  statusNote: string | null;
  title: string;
  summary: string | null;
  description: string | null;
  start: { date: string; time: string | null };
  end: { date: string | null; time: string | null };
  startsAt: string;
  endsAt: string;
  timeKnown: boolean;
  venue: { name: string; address: string | null; placeRef: string | null; lat: number | null; lng: number | null };
  price: { kind: PriceKind; note: string | null };
  organizer: string | null;
  links: { source: string | null; info: string | null; booking: string | null };
  verifiedAt: string | null;
}

export interface EventsData {
  territory: string;
  timezone: string;
  today: string;
  events: PublicEvent[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const STATUSES = new Set(["scheduled", "unconfirmed", "cancelled", "postponed"]);
const PRICE_KINDS = new Set(["free", "paid", "unknown"]);

function parseEvent(raw: unknown): PublicEvent | null {
  const e = obj(raw);
  const start = obj(e.start);
  const end = obj(e.end);
  const venue = obj(e.venue);
  const price = obj(e.price);
  const links = obj(e.links);
  const id = str(e.id);
  const title = str(e.title);
  const startsAt = str(e.startsAt);
  const endsAt = str(e.endsAt);
  const startDate = str(start.date);
  const venueName = str(venue.name);
  if (!id || !title || !startsAt || !endsAt || !startDate || !isIsoDate(startDate) || !venueName) return null;
  if (!Number.isFinite(Date.parse(startsAt)) || !Number.isFinite(Date.parse(endsAt))) return null;
  const category = (EVENT_CATEGORY_IDS as readonly string[]).includes(e.category as string) ? (e.category as EventCategoryId) : "other";
  const status = STATUSES.has(e.status as string) ? (e.status as EventStatusId) : "scheduled";
  return {
    id,
    category,
    status,
    statusNote: str(e.statusNote),
    title,
    summary: str(e.summary),
    description: str(e.description),
    start: { date: startDate, time: str(start.time) },
    end: { date: str(end.date), time: str(end.time) },
    startsAt,
    endsAt,
    timeKnown: e.timeKnown === true,
    venue: { name: venueName, address: str(venue.address), placeRef: str(venue.placeRef), lat: num(venue.lat), lng: num(venue.lng) },
    price: { kind: PRICE_KINDS.has(price.kind as string) ? (price.kind as PriceKind) : "unknown", note: str(price.note) },
    organizer: str(e.organizer),
    links: { source: safeHttpsUrl(links.source), info: safeHttpsUrl(links.info), booking: safeHttpsUrl(links.booking) },
    verifiedAt: str(e.verifiedAt),
  };
}

/** Risposta dell'API → dati utilizzabili; null se la forma non è quella attesa. Gli eventi malformati si scartano. */
export function parseEventsData(json: unknown): EventsData | null {
  const d = obj(json);
  const territory = obj(d.territory);
  const id = str(territory.id);
  const timezone = str(territory.timezone);
  const today = str(d.today);
  if (!id || !timezone || !isValidTimeZone(timezone) || !today || !isIsoDate(today) || !Array.isArray(d.events)) return null;
  return { territory: id, timezone, today, events: d.events.map(parseEvent).filter((e): e is PublicEvent => e !== null) };
}

export type EventsRange = "today" | "tomorrow" | "week";
export const EVENTS_RANGES: readonly EventsRange[] = ["today", "tomorrow", "week"];

/** Giorni della vista, a partire da «oggi» del territorio. */
export function rangeDates(today: string, range: EventsRange): string[] {
  if (range === "today") return [today];
  if (range === "tomorrow") return [addDays(today, 1)];
  return Array.from({ length: 7 }, (_, i) => addDays(today, i));
}

export interface EventsFilter {
  category: EventCategoryId | null;
  freeOnly: boolean;
}

export function matchesFilter(e: PublicEvent, f: EventsFilter): boolean {
  return (f.category === null || e.category === f.category) && (!f.freeOnly || e.price.kind === "free");
}

/** Giorni con i loro eventi (solo i giorni che ne hanno), senza quelli già finiti; un evento di più giorni in ognuno. */
export function eventDays(data: EventsData, range: EventsRange, filter: EventsFilter, now: number): { date: string; events: PublicEvent[] }[] {
  const byDay = eventsByDay(data.events.filter((e) => matchesFilter(e, filter)), rangeDates(data.today, range), data.timezone, now);
  return [...byDay].filter(([, list]) => list.length > 0).map(([date, events]) => ({ date, events }));
}

/** Numero di eventi distinti ancora da vivere in una vista (per la home: «Oggi · 3 eventi»). */
export function countInRange(data: EventsData, range: EventsRange, now: number): number {
  const ids = new Set(eventDays(data, range, { category: null, freeOnly: false }, now).flatMap((d) => d.events.map((e) => e.id)));
  return ids.size;
}

/** Categorie presenti nella settimana, nell'ordine fisso del vocabolario (per i filtri). */
export function categoriesIn(data: EventsData): EventCategoryId[] {
  const present = new Set(data.events.map((e) => e.category));
  return EVENT_CATEGORY_IDS.filter((c) => present.has(c));
}

const utcDay = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
};

/** «Oggi», «Domani» oppure «sabato 24 ottobre» / «Saturday 24 October». */
export function dayLabel(date: string, today: string, locale: string, words: { today: string; tomorrow: string }): string {
  if (date === today) return words.today;
  if (date === addDays(today, 1)) return words.tomorrow;
  return utcDay(date).toLocaleDateString(locale === "it" ? "it-IT" : "en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

const shortDay = (date: string, locale: string) =>
  utcDay(date).toLocaleDateString(locale === "it" ? "it-IT" : "en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * Orario dell'evento visto da un giorno: «21:00–23:00», «21:00 → 25 ott, 01:30», «fino alle 01:30» il giorno dopo,
 * «tutto il giorno» per gli eventi di più giorni senza orario, «orario da confermare» se l'orario non è noto.
 */
export function timeLabel(
  e: PublicEvent,
  day: string,
  locale: string,
  words: { tbc: string; allDay: string; until: (time: string) => string },
): string {
  if (!e.timeKnown || !e.start.time) {
    const multi = e.end.date !== null && e.end.date !== e.start.date;
    return multi ? words.allDay : words.tbc;
  }
  if (day !== e.start.date) return e.end.time ? words.until(e.end.time) : words.allDay;
  if (!e.end.time) return e.start.time;
  if (!e.end.date || e.end.date === e.start.date) return `${e.start.time}–${e.end.time}`;
  return `${e.start.time} → ${shortDay(e.end.date, locale)}, ${e.end.time}`;
}

/** Data dell'ultima verifica nel fuso del territorio: «20 ottobre 2026» / «20 October 2026». */
export function verifiedDate(iso: string | null, tz: string, locale: string): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return utcDay(localDate(t, isValidTimeZone(tz) ? tz : "UTC")).toLocaleDateString(locale === "it" ? "it-IT" : "en-GB", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

/** Indirizzo della richiesta all'API: solo il territorio e la lingua; il periodo è quello predefinito (sette giorni). */
export function eventsUrl(territory: string, lang: string | null): string {
  const q = new URLSearchParams({ territory });
  if (lang) q.set("lang", lang);
  return `/api/v1/events?${q.toString()}`;
}

/** Esito di una richiesta, da cui dipende cosa mostrare. `unavailable`: territorio senza calendario o servizio spento. */
export type EventsState =
  | { kind: "loading" }
  | { kind: "offline" }
  | { kind: "unavailable" }
  | { kind: "error" }
  | { kind: "ok"; data: EventsData };

/** Stato da una risposta HTTP: 404 e servizio non configurato non sono errori da mostrare, solo assenza di calendario. */
export function stateFromResponse(status: number, json: unknown): EventsState {
  if (status === 200) {
    const data = parseEventsData(json);
    return data ? { kind: "ok", data } : { kind: "error" };
  }
  if (status === 404 || (status === 503 && obj(json).error === "non_configurato")) return { kind: "unavailable" };
  return { kind: "error" };
}
