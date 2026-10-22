/**
 * API pubblica degli eventi del giorno (`GET /api/v1/events`): parametri, esiti e intestazioni di cache. Logica pura,
 * testata; la route la collega a `public_local_events()` (migrazione 20261031000000) con un client Supabase anonimo
 * senza cookie (`lib/public-supabase.ts`).
 *
 * La barriera vera è il database: la funzione pubblica restituisce solo eventi pubblicati di destinazioni
 * pubblicate, campi pubblici elencati uno per uno, e ricontrolla parametri e periodo. Qui si rifiutano subito le
 * richieste malformate, si traducono gli esiti in codici HTTP e si decide cosa può stare nella cache condivisa.
 * Nessun cookie, nessuna sessione, nessuna chiamata AI.
 */
import { daysBetween, isIsoDate, MAX_RANGE_DAYS } from "./local-events";
import { PACK_RE } from "./payments/shared";

export const EVENTS_API_VERSION = 1;

/**
 * Risposte riuscite: uguali per tutti, quindi nella cache della CDN per un minuto, poi servite ancora per cinque
 * mentre si aggiornano in background (un annullamento arriva al pubblico entro qualche minuto). `max-age=0`: il
 * browser chiede sempre alla CDN, non tiene una copia sua.
 */
export const PUBLIC_CACHE = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";
/** Errori e servizio non configurato: mai in cache. */
export const NO_STORE = "no-store";

const LANG_RE = /^[a-z]{2}$/;

export interface EventsQuery {
  territory: string;
  /** Null: lo decide il database (oggi nel fuso del territorio, e sette giorni). */
  from: string | null;
  to: string | null;
  lang: string | null;
}

/** Parametri della richiesta; null se malformati. `to` senza `from` non è ammesso (l'inizio lo dà il territorio). */
export function parseEventsQuery(params: URLSearchParams): EventsQuery | null {
  const value = (key: string) => {
    const v = params.get(key);
    return v === null || v.trim() === "" ? null : v.trim();
  };
  const territory = value("territory");
  if (!territory || territory.length > 120 || !PACK_RE.test(territory)) return null;
  const from = value("from");
  const to = value("to");
  const lang = value("lang");
  if ((from !== null && !isIsoDate(from)) || (to !== null && !isIsoDate(to))) return null;
  if (to !== null && from === null) return null;
  if (from !== null && to !== null) {
    const span = daysBetween(from, to);
    if (span < 0 || span + 1 > MAX_RANGE_DAYS) return null;
  }
  if (lang !== null && !LANG_RE.test(lang)) return null;
  return { territory, from, to, lang };
}

/** Argomenti di public_local_events. */
export const rpcArgs = (q: EventsQuery) => ({ p_pack: q.territory, p_from: q.from, p_to: q.to, p_lang: q.lang });

export type EventsRpc = (args: ReturnType<typeof rpcArgs>) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;

export interface EventsReply {
  status: number;
  body: Record<string, unknown>;
  cacheControl: string;
}

const failure = (status: number, error: string): EventsReply => ({ status, body: { version: EVENTS_API_VERSION, error }, cacheControl: NO_STORE });

/**
 * Esito della richiesta. `rpc` null: Supabase non configurato. Errori del database mai inoltrati (solo un codice
 * generico): 22023 = parametri rifiutati dalla funzione (periodo, lingua), qualsiasi altro = servizio non
 * disponibile. Territorio sconosciuto o non pubblicato = 404. Un territorio senza eventi risponde 200 con lista vuota.
 */
export async function eventsReply(params: URLSearchParams, rpc: EventsRpc | null): Promise<EventsReply> {
  const query = parseEventsQuery(params);
  if (!query) return failure(400, "parametri");
  if (!rpc) return failure(503, "non_configurato");
  let result: Awaited<ReturnType<EventsRpc>>;
  try {
    result = await rpc(rpcArgs(query));
  } catch {
    return failure(503, "non_disponibile");
  }
  if (result.error) return failure(result.error.code === "22023" ? 400 : 503, result.error.code === "22023" ? "parametri" : "non_disponibile");
  const data = result.data;
  if (data === null || data === undefined) return failure(404, "territorio");
  if (typeof data !== "object" || Array.isArray(data) || !Array.isArray((data as { events?: unknown }).events)) {
    return failure(503, "non_disponibile");
  }
  return { status: 200, body: { version: EVENTS_API_VERSION, ...(data as Record<string, unknown>) }, cacheControl: PUBLIC_CACHE };
}
