/**
 * Eventi del giorno: date, fusi orari e indirizzi delle fonti. Logica pura, testata, senza rete né AI.
 *
 * Tutte le date si leggono nel fuso orario del territorio (nome IANA, per esempio `Europe/Rome`), mai in quello del
 * server (Vercel, in UTC) o del dispositivo: ogni funzione riceve il fuso esplicitamente e usa solo `Date.UTC` e
 * `Intl.DateTimeFormat` con `timeZone`. Le date sono stringhe `AAAA-MM-GG`, gli orari `HH:MM`, gli istanti
 * millisecondi o stringhe ISO con la zona.
 *
 * Le stesse regole valgono nel database (`local_events`, fase 2): lì si calcolano `starts_at` ed `ends_at`, qui si
 * mostrano gli errori allo Studio prima del salvataggio e si raggruppano gli eventi per giorno nell'app.
 */

/** Periodo massimo che l'API accetta, estremi inclusi (D8). */
export const MAX_RANGE_DAYS = 14;
/** Periodo predefinito: oggi e i sei giorni seguenti («Prossimi 7 giorni»). */
export const DEFAULT_RANGE_DAYS = 7;
/** Durata massima di un evento; oltre, è una manifestazione con più appuntamenti (righe separate). */
export const MAX_EVENT_DAYS = 60;
/** Lunghezza massima di un indirizzo pubblico, uguale al vincolo del database. */
export const MAX_URL_LENGTH = 500;

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ------------------------------------------------------------------------------------------------ fusi orari

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Vero se il nome è un fuso IANA che il motore conosce. */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Data, ora e minuti locali di un istante nel fuso indicato. */
function localParts(instant: number, tz: string): { y: number; m: number; d: number; hh: number; mm: number; ss: number } {
  const p: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(new Date(instant))) p[part.type] = part.value;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour), mm: Number(p.minute), ss: Number(p.second) };
}

/** Scarto del fuso rispetto a UTC in un istante, in millisecondi (Europe/Rome d'estate: +2 h). */
function offsetAt(instant: number, tz: string): number {
  const l = localParts(instant, tz);
  const truncated = instant - (((instant % 1000) + 1000) % 1000);
  return Date.UTC(l.y, l.m - 1, l.d, l.hh, l.mm, l.ss) - truncated;
}

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

/** «AAAA-MM-GG» locale di un istante. */
export function localDate(instant: number, tz: string): string {
  const l = localParts(instant, tz);
  return `${pad(l.y, 4)}-${pad(l.m)}-${pad(l.d)}`;
}

/** «HH:MM» locale di un istante. */
export function localTime(instant: number, tz: string): string {
  const l = localParts(instant, tz);
  return `${pad(l.hh)}:${pad(l.mm)}`;
}

/** Oggi nel territorio: la data locale dell'istante `now`, non quella del server o del telefono. */
export function territoryToday(tz: string, now: number = Date.now()): string {
  return localDate(now, tz);
}

// ------------------------------------------------------------------------------------------------ date di calendario

/** Vero solo per una data di calendario esistente in formato AAAA-MM-GG (niente 31 aprile o 29 febbraio 2027). */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2999 || mo < 1 || mo > 12 || d < 1) return false;
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDate() === d;
}

/** Vero per un orario «HH:MM» da 00:00 a 23:59. */
export function isLocalTime(s: unknown): s is string {
  return typeof s === "string" && TIME_RE.test(s);
}

const dateToUtcMs = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};

/** La data `n` giorni dopo (o prima, se negativo). Aritmetica di calendario: il fuso non c'entra. */
export function addDays(date: string, n: number): string {
  const t = new Date(dateToUtcMs(date) + n * DAY_MS);
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Giorni da `from` a `to` (0 se uguali, negativo se `to` viene prima). */
export function daysBetween(from: string, to: string): number {
  return Math.round((dateToUtcMs(to) - dateToUtcMs(from)) / DAY_MS);
}

/** Le date da `from` a `to`, estremi inclusi. */
export function datesInRange(from: string, to: string): string[] {
  const n = daysBetween(from, to);
  return Array.from({ length: Math.max(0, n + 1) }, (_, i) => addDays(from, i));
}

export type RangeError = "data_non_valida" | "periodo_rovesciato" | "periodo_troppo_lungo";
export type RangeResult = { ok: true; from: string; to: string } | { ok: false; error: RangeError };

/**
 * Periodo richiesto all'API, con i valori predefiniti: da oggi (nel territorio) per sette giorni. Al massimo
 * `MAX_RANGE_DAYS` giorni, estremi inclusi: `to − from + 1 ≤ 14`.
 */
export function resolveRange(input: { from?: string | null; to?: string | null }, today: string): RangeResult {
  const from = input.from ?? today;
  if (!isIsoDate(from)) return { ok: false, error: "data_non_valida" };
  const to = input.to ?? addDays(from, DEFAULT_RANGE_DAYS - 1);
  if (!isIsoDate(to)) return { ok: false, error: "data_non_valida" };
  const span = daysBetween(from, to);
  if (span < 0) return { ok: false, error: "periodo_rovesciato" };
  if (span + 1 > MAX_RANGE_DAYS) return { ok: false, error: "periodo_troppo_lungo" };
  return { ok: true, from, to };
}

// ------------------------------------------------------------------------------------------------ da ora locale a istante

export type LocalInstant =
  | { status: "ok"; instant: number }
  /** L'ora non esiste (salto in avanti dell'ora legale): `instant` è dove la porterebbe l'orologio, un'ora dopo. */
  | { status: "nonexistent"; instant: number }
  /** L'ora esiste due volte (ritorno all'ora solare): `instant` è la prima delle due. */
  | { status: "ambiguous"; instant: number };

/**
 * Istante di una data e un'ora locali nel fuso del territorio, con il caso del cambio dell'ora dichiarato
 * invece che scelto in silenzio. Si confrontano i due scarti del fuso del giorno prima e del giorno dopo:
 * i candidati che riportano esattamente all'ora richiesta sono le interpretazioni possibili.
 */
export function localToInstant(date: string, time: string, tz: string): LocalInstant {
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const guess = dateToUtcMs(date) + (hh * 60 + mm) * 60_000;
  const before = offsetAt(guess - DAY_MS, tz);
  const after = offsetAt(guess + DAY_MS, tz);
  const matches = [...new Set([guess - before, guess - after])]
    .filter((c) => localDate(c, tz) === date && localTime(c, tz) === time)
    .sort((a, b) => a - b);
  if (matches.length === 1) return { status: "ok", instant: matches[0]! };
  if (matches.length > 1) return { status: "ambiguous", instant: matches[0]! };
  return { status: "nonexistent", instant: guess - before };
}

/** Inizio del giorno locale (mezzanotte, o il primo istante del giorno dove la mezzanotte non esiste). */
export function startOfLocalDay(date: string, tz: string): number {
  return localToInstant(date, "00:00", tz).instant;
}

// ------------------------------------------------------------------------------------------------ intervallo di un evento

export interface EventTimesInput {
  startDate: string;
  /** Null: «orario da confermare», l'evento occupa la giornata. */
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
}

export type EventTimesError =
  | "formato"
  | "fine_senza_inizio"
  | "fine_prima_inizio"
  | "troppo_lungo"
  | "orario_inesistente"
  | "orario_ambiguo";

export type EventTimes =
  | { ok: true; startsAt: number; endsAt: number; timeKnown: boolean }
  | { ok: false; error: EventTimesError };

/**
 * Inizio e fine di un evento come istanti, con le stesse regole del database:
 * - orario sconosciuto: dalla mezzanotte del giorno di inizio alla mezzanotte dopo l'ultimo giorno;
 * - orario d'inizio senza fine: fino alla fine del giorno di inizio;
 * - fine con orario: quell'istante (oltre la mezzanotte se `endDate` è il giorno dopo);
 * - fine con data ma senza orario: fino alla fine di quel giorno.
 * Gli orari che il cambio dell'ora rende inesistenti o doppi si rifiutano: meglio chiedere un orario diverso
 * che indovinare quale dei due si intendeva.
 */
export function eventTimes(input: EventTimesInput, tz: string): EventTimes {
  const { startDate, startTime, endTime } = input;
  const endDate = input.endDate ?? (endTime ? startDate : null);
  if (!isIsoDate(startDate) || (endDate !== null && !isIsoDate(endDate))) return { ok: false, error: "formato" };
  if ((startTime !== null && !isLocalTime(startTime)) || (endTime !== null && !isLocalTime(endTime))) {
    return { ok: false, error: "formato" };
  }
  if (endTime !== null && startTime === null) return { ok: false, error: "fine_senza_inizio" };
  if (endDate !== null && daysBetween(startDate, endDate) < 0) return { ok: false, error: "fine_prima_inizio" };

  const at = (date: string, time: string): number | EventTimesError => {
    const r = localToInstant(date, time, tz);
    return r.status === "ok" ? r.instant : r.status === "nonexistent" ? "orario_inesistente" : "orario_ambiguo";
  };
  const startsAt = startTime === null ? startOfLocalDay(startDate, tz) : at(startDate, startTime);
  if (typeof startsAt === "string") return { ok: false, error: startsAt };
  const endsAt = endTime !== null ? at(endDate!, endTime) : startOfLocalDay(addDays(endDate ?? startDate, 1), tz);
  if (typeof endsAt === "string") return { ok: false, error: endsAt };

  if (endsAt <= startsAt) return { ok: false, error: "fine_prima_inizio" };
  if (endsAt - startsAt > MAX_EVENT_DAYS * DAY_MS) return { ok: false, error: "troppo_lungo" };
  return { ok: true, startsAt, endsAt, timeKnown: startTime !== null };
}

// ------------------------------------------------------------------------------------------------ eventi per giorno

/** Il minimo che serve per collocare un evento nei giorni: gli istanti come li restituisce l'API (ISO con zona). */
export interface TimedEvent {
  startsAt: string;
  endsAt: string;
}

const ms = (iso: string) => Date.parse(iso);

/** Un evento finito (fine non dopo `now`) esce dalle liste attive; resta nello storico del database. */
export function isOver(event: TimedEvent, now: number): boolean {
  return ms(event.endsAt) <= now;
}

/** Vero se l'evento occupa almeno un momento del giorno locale (gli eventi oltre la mezzanotte toccano due giorni). */
export function touchesDay(event: TimedEvent, date: string, tz: string): boolean {
  const dayStart = startOfLocalDay(date, tz);
  const dayEnd = startOfLocalDay(addDays(date, 1), tz);
  return ms(event.startsAt) < dayEnd && ms(event.endsAt) > dayStart;
}

/**
 * Eventi per ciascun giorno richiesto, in ordine di inizio, senza quelli già finiti. Un evento di più giorni
 * compare in ognuno dei giorni che tocca.
 */
export function eventsByDay<E extends TimedEvent>(events: readonly E[], dates: readonly string[], tz: string, now: number): Map<string, E[]> {
  const active = events.filter((e) => !isOver(e, now)).sort((a, b) => ms(a.startsAt) - ms(b.startsAt));
  return new Map(dates.map((d) => [d, active.filter((e) => touchesDay(e, d, tz))]));
}

// ------------------------------------------------------------------------------------------------ indirizzi delle fonti

/**
 * Forma che il database accetta per un indirizzo pubblico (`is_public_https_url`, fase 2): solo https, host con
 * almeno un punto e senza credenziali, porta facoltativa, percorso senza spazi. Va copiata identica nella migrazione.
 */
export const PUBLIC_HTTPS_URL_PATTERN =
  "^https://[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+(:[0-9]{1,5})?(/[^\\s]*)?$";
const PUBLIC_HTTPS_URL_RE = new RegExp(PUBLIC_HTTPS_URL_PATTERN);
// eslint-disable-next-line no-control-regex -- si cercano proprio spazi e caratteri di controllo
const SPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;

/**
 * Indirizzo https pubblico e ben formato, nella forma normalizzata da salvare; null se non è accettabile.
 * Rifiuta altri schemi (`javascript:`, `data:`, `http:`…), credenziali nell'indirizzo, spazi e caratteri di
 * controllo, host senza dominio, indirizzi troppo lunghi. Controlla solo la forma: che la pagina sia davvero la
 * fonte ufficiale lo stabilisce la verifica della redazione. Nessuna richiesta di rete.
 */
export function safeHttpsUrl(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_URL_LENGTH) return null;
  // Il parser del browser corregge «https:example.org» in «https://example.org/»: un indirizzo scritto male si
  // rifiuta invece di indovinarlo.
  if (SPACE_OR_CONTROL.test(input) || !/^https:\/\//i.test(input)) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  const href = url.href;
  if (href.length > MAX_URL_LENGTH || !PUBLIC_HTTPS_URL_RE.test(href)) return null;
  return href;
}
