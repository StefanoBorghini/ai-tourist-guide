/**
 * API pubblica della directory delle attività locali (`GET /api/v1/businesses`): parametri, esiti e cache. Logica pura,
 * testata; la route la collega a `public_local_businesses()` (migrazione 20261105000000) con il client anonimo senza
 * cookie (`lib/public-supabase.ts`), come per gli eventi.
 *
 * La barriera vera è il database: solo attività pubblicate di destinazioni pubblicate, campi pubblici elencati uno per
 * uno, in ordine alfabetico. Qui si rifiutano le richieste malformate e si traducono gli esiti in codici HTTP.
 * Nessun cookie, nessuna sessione, nessuna chiamata AI.
 */
import { NO_STORE, PUBLIC_CACHE } from "./events-api";
import { PACK_RE } from "./payments/shared";

export const BUSINESSES_API_VERSION = 1;
const LANG_RE = /^[a-z]{2}$/;

export interface BusinessesQuery {
  territory: string;
  lang: string | null;
}

export function parseBusinessesQuery(params: URLSearchParams): BusinessesQuery | null {
  const value = (key: string) => {
    const v = params.get(key);
    return v === null || v.trim() === "" ? null : v.trim();
  };
  const territory = value("territory");
  if (!territory || territory.length > 120 || !PACK_RE.test(territory)) return null;
  const lang = value("lang");
  if (lang !== null && !LANG_RE.test(lang)) return null;
  return { territory, lang };
}

export const businessesRpcArgs = (q: BusinessesQuery) => ({ p_pack: q.territory, p_lang: q.lang });

export type BusinessesRpc = (args: ReturnType<typeof businessesRpcArgs>) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;

export interface BusinessesReply {
  status: number;
  body: Record<string, unknown>;
  cacheControl: string;
}

const failure = (status: number, error: string): BusinessesReply => ({ status, body: { version: BUSINESSES_API_VERSION, error }, cacheControl: NO_STORE });

/** Stesse regole degli eventi: 400 parametri, 503 non configurato o non disponibile, 404 territorio, 200 anche vuoto. */
export async function businessesReply(params: URLSearchParams, rpc: BusinessesRpc | null): Promise<BusinessesReply> {
  const query = parseBusinessesQuery(params);
  if (!query) return failure(400, "parametri");
  if (!rpc) return failure(503, "non_configurato");
  let result: Awaited<ReturnType<BusinessesRpc>>;
  try {
    result = await rpc(businessesRpcArgs(query));
  } catch {
    return failure(503, "non_disponibile");
  }
  if (result.error) return failure(result.error.code === "22023" ? 400 : 503, result.error.code === "22023" ? "parametri" : "non_disponibile");
  const data = result.data;
  if (data === null || data === undefined) return failure(404, "territorio");
  if (typeof data !== "object" || Array.isArray(data) || !Array.isArray((data as { businesses?: unknown }).businesses)) {
    return failure(503, "non_disponibile");
  }
  return { status: 200, body: { version: BUSINESSES_API_VERSION, ...(data as Record<string, unknown>) }, cacheControl: PUBLIC_CACHE };
}
