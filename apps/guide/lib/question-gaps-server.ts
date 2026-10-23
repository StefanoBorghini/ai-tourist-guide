/**
 * Registro delle domande senza risposta, lato server: l'unico punto in cui la guida usa la chiave di servizio di
 * Supabase per le domande, e solo per la funzione gap_record() (migrazione 20261103000000), che è tutto ciò che quel
 * ruolo può fare sulle tabelle delle domande. La chiave non arriva mai al browser e non finisce nei log.
 *
 * Spento per default: si accende con QUESTION_GAPS_ENABLED=1, insieme a NEXT_PUBLIC_SUPABASE_URL e
 * SUPABASE_SERVICE_ROLE_KEY. La registrazione parte dopo la risposta al visitatore (after() di Next) e non può
 * cambiarla: un errore o un database lento (oltre 2 secondi) lasciano solo un log senza testo.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import type { GapRecord } from "./question-gaps";

const TIMEOUT_MS = 2_000;

export interface QuestionGapsConfig {
  url: string;
  serviceKey: string;
}

/** Configurazione dalle variabili del server, oppure null (registro spento). */
export function questionGapsConfig(env: Record<string, string | undefined>): QuestionGapsConfig | null {
  if (env.QUESTION_GAPS_ENABLED?.trim() !== "1") return null;
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!/^https:\/\/[^\s/]+/.test(url) || serviceKey.length < 20) {
    console.error(JSON.stringify({ event: "question_gaps_config_error", missing: [!/^https:\/\//.test(url) && "NEXT_PUBLIC_SUPABASE_URL", serviceKey.length < 20 && "SUPABASE_SERVICE_ROLE_KEY"].filter(Boolean) }));
    return null;
  }
  return { url, serviceKey };
}

let client: SupabaseClient | null = null;
const clientFor = (config: QuestionGapsConfig) =>
  (client ??= createClient(config.url, config.serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }));

/**
 * Registra la domanda. Non lancia mai: restituisce l'esito di gap_record ('created', 'updated', 'limit', …) oppure
 * 'error'. Nei log solo l'esito e il codice dell'errore: né il testo della domanda né la chiave.
 */
export async function recordQuestionGap(config: QuestionGapsConfig, gap: GapRecord): Promise<string> {
  try {
    const { data, error } = await clientFor(config)
      .rpc("gap_record", {
        p_pack: gap.pack,
        p_locale: gap.locale,
        p_question: gap.question,
        p_key: gap.key,
        p_kind: gap.kind,
        p_place: gap.place,
        p_selected: gap.selected,
        p_reason: gap.reason,
        p_web_sources: gap.webSources,
        p_kb_hash: gap.kbHash,
        p_prompt: gap.prompt,
      })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (error) {
      console.warn(JSON.stringify({ event: "question_gap_failed", code: error.code ?? null }));
      return "error";
    }
    const result = typeof data === "string" ? data : "error";
    console.info(JSON.stringify({ event: "question_gap", kind: gap.kind, result }));
    return result;
  } catch (e) {
    console.warn(JSON.stringify({ event: "question_gap_failed", code: (e as Error).name === "AbortError" || (e as Error).name === "TimeoutError" ? "timeout" : "exception" }));
    return "error";
  }
}

/** Registra dopo la risposta. Fuori da una richiesta di Next (prove, script) parte subito, senza attendere. */
export function scheduleQuestionGap(config: QuestionGapsConfig, gap: GapRecord): void {
  const task = () => recordQuestionGap(config, gap);
  try {
    after(task);
  } catch {
    void task();
  }
}
