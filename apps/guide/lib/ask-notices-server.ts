/**
 * Avvisi operativi per le domande a Gaia, lato server: legge `public_operational_notices()` con il client anonimo senza
 * cookie (`public-supabase.ts`), al massimo una volta al minuto per destinazione e lingua, con un tempo massimo breve.
 * Mai la chiave di servizio: la funzione pubblica restituisce solo avvisi pubblicati, verificati e in vigore.
 *
 * Esiti (vedi `NoticeSet` in `ask-notices.ts`):
 * - undefined: la destinazione non ha avvisi (Supabase non configurato, destinazione non nel database o non
 *   pubblicata, migrazione non ancora applicata): la domanda procede come prima;
 * - `unavailable`: errore o risposta lenta: Gaia lo sa e non può dire lo stato di oggi da un avviso;
 * - `ok`: gli avvisi in vigore, anche nessuno.
 */
import { parseNotices, type NoticeSet } from "./ask-notices";

export const NOTICES_TIMEOUT_MS = 1_500;
export const NOTICES_TTL_MS = 60_000;
/** Un errore si ricorda poco: la domanda successiva riprova presto, ma non a ogni richiesta. */
export const NOTICES_ERROR_TTL_MS = 10_000;

/** Funzione o tabella assenti: la migrazione 20261105000000 non è applicata (PostgREST: PGRST202; Postgres: 42883). */
const MISSING = new Set(["PGRST202", "42883", "42P01"]);

export type NoticesRpc = (args: { p_pack: string; p_lang: string }, signal: AbortSignal) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;

export class NoticeLoader {
  private cache = new Map<string, { until: number; value: NoticeSet | undefined }>();
  private missingLogged = false;

  constructor(
    private readonly rpc: NoticesRpc | null,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = NOTICES_TIMEOUT_MS,
  ) {}

  async load(pack: string, lang: string): Promise<NoticeSet | undefined> {
    if (!this.rpc) return undefined;
    const key = `${pack}|${lang}`;
    const hit = this.cache.get(key);
    if (hit && hit.until > this.now()) return hit.value;
    const value = await this.fetch(pack, lang);
    const ttl = value?.state === "unavailable" ? NOTICES_ERROR_TTL_MS : NOTICES_TTL_MS;
    this.cache.set(key, { until: this.now() + ttl, value });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  private async fetch(pack: string, lang: string): Promise<NoticeSet | undefined> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, this.timeoutMs);
    });
    try {
      const result = await Promise.race([Promise.resolve(this.rpc!({ p_pack: pack, p_lang: lang }, controller.signal)), timeout]);
      if (result === "timeout") return this.unavailable("timeout");
      if (result.error) {
        if (result.error.code && MISSING.has(result.error.code)) {
          if (!this.missingLogged) console.warn(JSON.stringify({ event: "notices_missing", code: result.error.code }));
          this.missingLogged = true;
          return undefined;
        }
        return this.unavailable(result.error.code ?? "error");
      }
      // Destinazione non pubblicata nel database (per esempio solo dai file): nessun avviso previsto.
      if (result.data === null || result.data === undefined) return undefined;
      return parseNotices(result.data, pack) ?? this.unavailable("format");
    } catch {
      return this.unavailable("error");
    } finally {
      clearTimeout(timer);
    }
  }

  private unavailable(code: string): NoticeSet {
    console.warn(JSON.stringify({ event: "notices_unavailable", code }));
    return { state: "unavailable" };
  }
}
