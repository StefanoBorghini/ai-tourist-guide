/**
 * Costi delle domande alla guida: listino, consumi restituiti dall'API e budget per domanda.
 * Logica pura, niente rete: la usano la route, `ask:eval` e i test.
 *
 * Il budget (ASK_MAX_USD_PER_QUESTION) è una protezione basata su stime prudenti, NON un tetto
 * matematico. Prima di ogni chiamata si calcola il caso peggiore conoscibile (ingresso stimato per
 * eccesso, `max_tokens`, ricerche consentite) e, se non ci sta nel residuo, la chiamata non parte;
 * `max_tokens` si riduce al residuo. Restano non conoscibili in anticipo:
 * - il testo dei risultati di ricerca che il modello legge (si conta una stima per ricerca,
 *   SEARCH_RESULT_TOKENS_ALLOWANCE; il valore reale si sa solo a risposta arrivata);
 * - il ripiego automatico su un altro modello (`fallbacks`), che può pagare due passaggi.
 * Dopo ogni chiamata si scala il costo reale (dai consumi dell'API, per modello): le chiamate
 * successive vedono il residuo vero. Il tetto rigido resta il limite di spesa del workspace nella
 * Console Anthropic.
 */

// ------------------------------------------------------------------ listino

/** Dollari per milione di token: ingresso, scrittura in cache (5 minuti), lettura dalla cache, uscita. */
export interface Rates {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/**
 * Listino pubblico Anthropic (verificato il 2026-10-13 sulla documentazione dell'API).
 * Dove il listino dà solo ingresso e uscita, cache derivata dalla regola generale:
 * scrittura 1,25× e lettura 0,1× del prezzo d'ingresso (Opus 5.5 legge a 0,05×, prezzo pubblicato).
 * Haiku 5.5 ha due fasce: fino a 100.000 token di prompt e oltre.
 * claude-opus-5 e claude-opus-4-8 sono i modelli di ripiego documentati per `fallbacks`.
 */
const PRICES: Record<string, { rates: Rates; above?: { promptTokens: number; rates: Rates } }> = {
  "claude-opus-5-5": { rates: { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 } },
  "claude-sonnet-5-5": { rates: { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 } },
  "claude-haiku-5-5": {
    rates: { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
    above: { promptTokens: 100_000, rates: { input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 } },
  },
  "claude-opus-5": { rates: { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 } },
  "claude-opus-4-8": { rates: { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 } },
};
/** 10 $ ogni 1.000 ricerche. */
export const WEB_SEARCH_USD = 0.01;

/** Tariffe più alte del listino, voce per voce: si usano per i modelli non in tabella (mai costo zero). */
export const CONSERVATIVE_RATES: Rates = (() => {
  const all = Object.values(PRICES).flatMap((p) => [p.rates, ...(p.above ? [p.above.rates] : [])]);
  const max = (k: keyof Rates) => Math.max(...all.map((r) => r[k]));
  return { input: max("input"), cacheWrite: max("cacheWrite"), cacheRead: max("cacheRead"), output: max("output") };
})();

/** Nome del modello nel listino: esatto, oppure con il suffisso di data (es. `claude-opus-4-8-20260101`). */
function priceEntry(model: string) {
  if (PRICES[model]) return PRICES[model];
  const base = /^(.*)-\d{8}$/.exec(model)?.[1];
  return base ? PRICES[base] : undefined;
}

/** Tariffe del modello per un prompt di questa dimensione; null se il modello non è in listino. */
export function ratesFor(model: string, promptTokens = 0): Rates | null {
  const p = priceEntry(model);
  if (!p) return null;
  return p.above && promptTokens > p.above.promptTokens ? p.above.rates : p.rates;
}

// ------------------------------------------------------------------ consumi

export interface Usage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  webSearches: number;
}
export const emptyUsage = (): Usage => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, webSearches: 0 });
export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    input: a.input + (b.input ?? 0),
    cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0),
    cacheRead: a.cacheRead + (b.cacheRead ?? 0),
    output: a.output + (b.output ?? 0),
    webSearches: a.webSearches + (b.webSearches ?? 0),
  };
}

const usd = (u: Usage, r: Rates) =>
  (u.input * r.input + u.cacheWrite * r.cacheWrite + u.cacheRead * r.cacheRead + u.output * r.output) / 1e6 + u.webSearches * WEB_SEARCH_USD;
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** Costo a listino dei consumi di UNA chiamata; null se il modello non è in tabella. */
export function estimateUsd(model: string, u: Usage): number | null {
  const r = ratesFor(model, u.input + u.cacheRead + u.cacheWrite);
  return r ? round5(usd(u, r)) : null;
}

/** I campi dei consumi che servono qui, come li restituisce l'API (`usage`, con i passaggi in `iterations`). */
export interface ApiUsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
  iterations?: Array<{
    type: string;
    model?: string | null;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  }> | null;
}

const toUsage = (u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): Usage => ({
  input: u.input_tokens ?? 0,
  cacheWrite: u.cache_creation_input_tokens ?? 0,
  cacheRead: u.cache_read_input_tokens ?? 0,
  output: u.output_tokens ?? 0,
  webSearches: 0,
});

/**
 * Consumi di una risposta divisi per modello. Se l'API riporta i passaggi (`iterations`: giri della
 * ricerca, modello che ha declinato e modello di ripiego) si prezzano uno per uno con il loro modello;
 * altrimenti si usa il totale con il modello che ha risposto. Le ricerche vanno sull'ultimo passaggio.
 */
export function usageParts(u: ApiUsageLike, servedModel: string, requestedModel: string): { model: string; usage: Usage }[] {
  const searches = u.server_tool_use?.web_search_requests ?? 0;
  const steps = (u.iterations ?? []).filter((it) => typeof it.input_tokens === "number" || typeof it.output_tokens === "number");
  const parts = steps.length > 0
    ? steps.map((it) => ({ model: it.model || (it.type === "fallback_message" ? servedModel : requestedModel), usage: toUsage(it) }))
    : [{ model: servedModel || requestedModel, usage: toUsage(u) }];
  parts[parts.length - 1]!.usage.webSearches = searches;
  return parts;
}

/** Totale dei consumi (per i log e per il contatore della risposta). */
export const totalUsage = (parts: { usage: Usage }[]) => parts.reduce((acc, p) => addUsage(acc, p.usage), emptyUsage());

/**
 * Token del contesto per il giro successivo (dopo `pause_turn` si rimanda tutta la conversazione):
 * prompt dell'ultimo passaggio più ciò che ha scritto. Senza passaggi si usa il totale (per eccesso).
 */
export function nextContextTokens(u: ApiUsageLike): number {
  const last = (u.iterations ?? []).filter((it) => it.type === "message" || it.type === "fallback_message").at(-1);
  const src = last ?? u;
  return (src.input_tokens ?? 0) + (src.cache_read_input_tokens ?? 0) + (src.cache_creation_input_tokens ?? 0) + (src.output_tokens ?? 0);
}

// ------------------------------------------------------------------ stime prima della chiamata

/**
 * Caratteri per token usati per stimare l'ingresso PRIMA della chiamata. Valore volutamente basso
 * (stima per eccesso dei token): l'italiano sta in genere sopra i 3 caratteri per token. Da tarare
 * con i consumi reali registrati da `ask:eval` (token in ingresso / caratteri inviati).
 */
export const CHARS_PER_TOKEN = 2;
/** Token aggiunti dall'API per formato della risposta e strumenti, stima per eccesso. */
export const REQUEST_OVERHEAD_TOKENS = 1_000;
/**
 * Token dei risultati di UNA ricerca che il modello legge: non conoscibili prima della risposta.
 * È un'ipotesi da tarare con `ask:eval` (consumi del primo giro): il budget li conta così, la spesa
 * reale può essere più alta.
 */
export const SEARCH_RESULT_TOKENS_ALLOWANCE = 10_000;

/** Token stimati per eccesso di un insieme di testi, più il sovrappiù dell'API. */
export function estimateInputTokens(...texts: string[]): number {
  return Math.ceil(texts.reduce((n, t) => n + t.length, 0) / CHARS_PER_TOKEN) + REQUEST_OVERHEAD_TOKENS;
}

// ------------------------------------------------------------------ configurazione del budget

export type BudgetConfig = { ok: true; maxUsd: number } | { ok: false; error: string };

/**
 * ASK_MAX_USD_PER_QUESTION: dollari massimi STIMATI per domanda (es. `0.15`). Obbligatoria: senza un
 * valore valido le domande all'AI restano spente (nessuna chiamata), non si ripiega su un default.
 * È distinta da prezzi e quote commerciali.
 */
export function questionBudgetConfig(env: Record<string, string | undefined> = process.env): BudgetConfig {
  const raw = env.ASK_MAX_USD_PER_QUESTION?.trim();
  if (!raw) return { ok: false, error: "ASK_MAX_USD_PER_QUESTION non impostata: domande all'AI spente" };
  if (!/^\d+(\.\d+)?$/.test(raw)) return { ok: false, error: "ASK_MAX_USD_PER_QUESTION non valida: serve un numero in dollari con il punto (es. 0.15)" };
  const maxUsd = Number(raw);
  if (!(maxUsd > 0) || !Number.isFinite(maxUsd)) return { ok: false, error: "ASK_MAX_USD_PER_QUESTION deve essere maggiore di zero" };
  return { ok: true, maxUsd };
}

// ------------------------------------------------------------------ budget di una domanda

/**
 * measured: consumi restituiti dall'API, prezzati a listino.
 * estimated: almeno una chiamata senza consumi (tempo scaduto, rete): contato il suo caso peggiore.
 * unknown: almeno un modello non in listino: contato con le tariffe più alte del listino.
 */
export type CostQuality = "measured" | "estimated" | "unknown";
const QUALITY_ORDER: CostQuality[] = ["measured", "estimated", "unknown"];

export interface CallPlan {
  model: string;
  maxTokens: number;
  searches: number;
  /** Caso peggiore stimato della chiamata (con la stima dei risultati di ricerca). */
  worstUsd: number;
}
export type PlanResult = ({ ok: true } & CallPlan) | { ok: false; reason: string; worstUsd: number };

export interface CallRecord {
  kind: "local" | "web";
  round?: number;
  /** Modelli che hanno consumato (dai consumi dell'API); il richiesto se la chiamata è fallita. */
  models: string[];
  maxTokens: number;
  searchesAllowed: number;
  outcome: "ok" | "error";
  error?: string;
  /** Consumi restituiti dall'API (null se la chiamata è fallita senza consumi). */
  usage: Usage | null;
  /** Dollari scalati dal budget per questa chiamata. */
  usd: number;
  quality: CostQuality;
}

export interface BudgetSummary {
  limitUsd: number;
  spentUsd: number;
  quality: CostQuality;
  calls: number;
  /** Motivo per cui il budget ha fermato una chiamata (se è successo). */
  stop?: string;
}

export class QuestionBudget {
  readonly calls: CallRecord[] = [];
  private stops: string[] = [];
  constructor(readonly limitUsd: number) {
    if (!(limitUsd > 0) || !Number.isFinite(limitUsd)) throw new Error("budget per domanda non valido");
  }

  get spentUsd(): number {
    return round5(this.calls.reduce((t, c) => t + c.usd, 0));
  }
  get remainingUsd(): number {
    return Math.max(0, this.limitUsd - this.spentUsd);
  }
  get quality(): CostQuality {
    return this.calls.reduce<CostQuality>((q, c) => (QUALITY_ORDER.indexOf(c.quality) > QUALITY_ORDER.indexOf(q) ? c.quality : q), "measured");
  }
  get stop(): string | undefined {
    return this.stops[0];
  }

  /**
   * Prepara una chiamata: con il residuo (meno `keepUsd`, tenuti da parte per un ripiego) quante
   * ricerche e quanti token in uscita ci stanno, nel caso peggiore stimato? Ingresso tutto al prezzo
   * più alto (scrittura in cache), ricerche con la stima dei risultati. Prova da `searches` a
   * `minSearches`; se nemmeno il minimo ci sta, la chiamata non va fatta.
   */
  plan(p: { model: string; inputTokens: number; maxTokens: number; minTokens: number; searches?: number; minSearches?: number; keepUsd?: number }): PlanResult {
    const available = this.remainingUsd - (p.keepUsd ?? 0);
    let worst = Infinity;
    for (let s = p.searches ?? 0; s >= (p.minSearches ?? 0); s--) {
      const prompt = p.inputTokens + s * SEARCH_RESULT_TOKENS_ALLOWANCE;
      const r = ratesFor(p.model, prompt) ?? CONSERVATIVE_RATES;
      const fixed = (prompt * Math.max(r.input, r.cacheWrite)) / 1e6 + s * WEB_SEARCH_USD;
      const maxOut = Math.floor(((available - fixed) * 1e6) / r.output);
      worst = Math.min(worst, fixed + (p.minTokens * r.output) / 1e6);
      if (maxOut >= p.minTokens) {
        const maxTokens = Math.min(p.maxTokens, maxOut);
        return { ok: true, model: p.model, maxTokens, searches: s, worstUsd: round5(fixed + (maxTokens * r.output) / 1e6) };
      }
    }
    return { ok: false, reason: `budget insufficiente (residuo ${round5(available)} $, minimo stimato ${round5(worst)} $)`, worstUsd: round5(worst) };
  }

  /** Il budget ha impedito una chiamata: si annota il motivo (per i log). */
  stopped(reason: string): void {
    this.stops.push(reason);
  }

  /** Chiamata riuscita: si scala il costo reale, per modello, dai consumi restituiti. */
  recordSuccess(kind: CallRecord["kind"], plan: CallPlan, apiUsage: ApiUsageLike, servedModel: string, round?: number): CallRecord {
    const parts = usageParts(apiUsage, servedModel, plan.model);
    let quality: CostQuality = "measured";
    let total = 0;
    for (const { model, usage } of parts) {
      const known = estimateUsd(model, usage);
      if (known === null) quality = "unknown";
      total += known ?? usd(usage, CONSERVATIVE_RATES);
    }
    const record: CallRecord = {
      kind,
      ...(round ? { round } : {}),
      models: [...new Set(parts.map((p) => p.model))],
      maxTokens: plan.maxTokens,
      searchesAllowed: plan.searches,
      outcome: "ok",
      usage: totalUsage(parts),
      usd: round5(total),
      quality,
    };
    this.calls.push(record);
    return record;
  }

  /**
   * Chiamata fallita. Un rifiuto HTTP 4xx dell'API (richiesta non eseguita) non consuma; per tutto
   * il resto (tempo scaduto, rete, 5xx) i consumi non si conoscono e si scala il caso peggiore
   * stimato, marcato come stima: mai costo zero.
   */
  recordFailure(kind: CallRecord["kind"], plan: CallPlan, error: { message: string; rejectedByApi: boolean }, round?: number): CallRecord {
    const record: CallRecord = {
      kind,
      ...(round ? { round } : {}),
      models: [plan.model],
      maxTokens: plan.maxTokens,
      searchesAllowed: plan.searches,
      outcome: "error",
      error: error.message.slice(0, 200),
      usage: null,
      usd: error.rejectedByApi ? 0 : plan.worstUsd,
      quality: error.rejectedByApi ? "measured" : "estimated",
    };
    this.calls.push(record);
    return record;
  }

  summary(): BudgetSummary {
    return { limitUsd: this.limitUsd, spentUsd: this.spentUsd, quality: this.quality, calls: this.calls.length, ...(this.stop ? { stop: this.stop } : {}) };
  }
}
