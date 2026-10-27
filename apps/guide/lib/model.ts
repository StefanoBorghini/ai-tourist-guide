/**
 * Modello linguistico dietro un'interfaccia: la risposta dalla base locale non dipende dal fornitore.
 *
 * - AnthropicAdapter: il comportamento di sempre (structured output, cache del prompt, ripiego lato server).
 * - OpenAICompatibleAdapter: qualunque servizio con l'API "chat completions" (Mistral, vLLM, servizi
 *   gestiti di modelli aperti…, anche un server locale come Ollama), con output JSON vincolato dallo schema
 *   (o solo JSON, ASK_JSON_MODE=json_object, per i servizi che non applicano lo schema). Nessuna dipendenza
 *   in più: usa fetch. Guida: docs/v0.4-gaia/PROVIDER-ALTERNATIVI.md.
 *
 * La ricerca web (ask-web.ts) resta uno strumento lato server di Anthropic: con un altro fornitore la
 * guida risponde con la sola base locale, a meno che sia configurata anche la chiave di Anthropic.
 * Configurazione dalle variabili d'ambiente (modelsFromEnv), nessun segreto nei log.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ApiUsageLike } from "./ask-cost";

export interface ModelRequest {
  /** Blocchi di sistema, in ordine; `cache` segna la fine del prefisso da tenere in cache. */
  system: { text: string; cache?: boolean }[];
  user: string;
  /** Schema JSON imposto alla risposta. */
  jsonSchema: Record<string, unknown>;
  maxTokens: number;
  timeoutMs: number;
}

export interface ModelResponse {
  text: string;
  stop: "end" | "refusal" | "length";
  /**
   * Consumi nella forma dell'API di Anthropic (ask-cost.ts li prezza, per modello). null: il fornitore non li
   * ha riportati; il budget conta allora il caso peggiore stimato, mai zero.
   */
  usage: ApiUsageLike | null;
  /** Modello che ha risposto davvero (con un ripiego può non essere quello richiesto). */
  model: string;
}

export interface ModelAdapter {
  readonly provider: string;
  readonly model: string;
  generate(req: ModelRequest): Promise<ModelResponse>;
}

/**
 * Errore del fornitore, nella forma che serve alla route (nessun segreto nel messaggio).
 * "timeout": nessuna risposta entro il tempo concesso (la chiamata può essere già stata pagata).
 */
export class ModelError extends Error {
  constructor(
    readonly kind: "rate_limit" | "unavailable" | "timeout",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

// ------------------------------------------------------------------ Anthropic

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

export class AnthropicAdapter implements ModelAdapter {
  readonly provider = "anthropic";
  constructor(
    private readonly client: Anthropic,
    readonly model: string = DEFAULT_ANTHROPIC_MODEL,
  ) {}

  async generate(req: ModelRequest): Promise<ModelResponse> {
    let response: Anthropic.Beta.Messages.BetaMessage;
    try {
      response = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: req.maxTokens,
          // Se il modello declina, l'API ripete la richiesta sul modello di ripiego consigliato.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          // Risposte da leggere a voce: poca riflessione, latenza bassa.
          output_config: { effort: "low", format: { type: "json_schema", schema: req.jsonSchema } },
          system: req.system.map((b) => ({ type: "text" as const, text: b.text, ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}) })),
          messages: [{ role: "user", content: req.user }],
        },
        // Nessun nuovo tentativo automatico: tre tentativi da timeoutMs supererebbero il tempo massimo
        // della route, che verrebbe interrotta senza risposta. Il visitatore può sempre richiedere.
        { timeout: req.timeoutMs, maxRetries: 0 },
      );
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) throw new ModelError("rate_limit", "limite di richieste del fornitore", 429);
      if (error instanceof Anthropic.APIConnectionTimeoutError) throw new ModelError("timeout", `nessuna risposta entro ${req.timeoutMs} ms`);
      if (error instanceof Anthropic.APIError) throw new ModelError("unavailable", `API ${error.status ?? "?"}: ${error.message}`.slice(0, 300), error.status);
      throw error;
    }
    return {
      text: response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
      stop: response.stop_reason === "refusal" ? "refusal" : response.stop_reason === "max_tokens" ? "length" : "end",
      // Consumi così come li dà l'API, con i passaggi del ripiego (`iterations`): il budget li prezza per modello.
      usage: response.usage,
      model: response.model || this.model,
    };
  }
}

// ------------------------------------------------------------------ API compatibili OpenAI

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Formato JSON chiesto al servizio:
 * - "json_schema" (predefinito): output vincolato dallo schema (`strict`), come con Anthropic;
 * - "json_object": solo JSON valido, per i servizi che non applicano lo schema; lo schema arriva al modello
 *   come istruzione di formato in fondo al messaggio di sistema.
 * In entrambi i casi la risposta passa dagli stessi controlli (ask.ts → checkModelAnswer): un JSON che non
 * rispetta lo schema viene scartato, non accettato.
 */
export const JSON_MODES = ["json_schema", "json_object"] as const;
export type JsonMode = (typeof JSON_MODES)[number];

interface ChatCompletion {
  model?: string;
  choices?: { finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null } | null;
}

/** Errore di tempo scaduto di AbortSignal.timeout (o di un'interruzione). */
const isTimeout = (error: unknown) => {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
};

/** Lunghezza massima del motivo che il servizio scrive nel corpo di una risposta di errore (per i log). */
export const ERROR_DETAIL_CHARS = 200;

/**
 * Motivo di un errore HTTP come lo scrive il servizio (es. Ollama: `{"error":"…"}`), accorciato e su una riga:
 * senza, nei log resta solo «HTTP 500». È il testo del fornitore, non i dati del visitatore; la chiave, se il
 * servizio la ripetesse, viene mascherata. Vuoto se il corpo non si legge.
 */
async function errorDetail(res: Response, apiKey: string | null): Promise<string> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    return "";
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    const e = parsed?.error;
    if (typeof e === "string") text = e;
    else if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") text = (e as { message: string }).message;
  } catch {
    // Non JSON: si usa il testo così com'è.
  }
  if (apiKey) text = text.split(apiKey).join("[chiave]");
  const line = text.replace(/\s+/g, " ").trim().slice(0, ERROR_DETAIL_CHARS);
  return line ? `: ${line}` : "";
}

/**
 * Limiti interni del `fetch` di Node (5 minuti per l'inizio della risposta o tra un pezzo e l'altro): arrivano come
 * «fetch failed» con il codice nella causa. Sono tempi scaduti, non errori di rete (vedi lib/eval-fetch.ts).
 */
const isFetchTimeout = (error: unknown) => {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT";
};

export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly provider = "openai-compatible";
  /**
   * @param apiKey null o vuota: nessuna intestazione di autenticazione (server locale senza chiave; la
   *   configurazione lo consente solo per indirizzi locali, vedi modelsConfig).
   */
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null,
    readonly model: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly jsonMode: JsonMode = "json_schema",
  ) {}

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    // Un solo messaggio di sistema: il prefisso resta identico tra le richieste (cache dove il servizio la offre).
    let system = req.system.map((b) => b.text).join("\n\n");
    if (this.jsonMode === "json_object") {
      system += `\n\nFORMATO DELLA RISPOSTA: un solo oggetto JSON, senza altro testo, conforme a questo JSON Schema:\n${JSON.stringify(req.jsonSchema)}`;
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let res: Response;
    let body: ChatCompletion | null;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          max_tokens: req.maxTokens,
          temperature: 0.3,
          messages: [
            { role: "system", content: system },
            { role: "user", content: req.user },
          ],
          response_format:
            this.jsonMode === "json_object"
              ? { type: "json_object" }
              : { type: "json_schema", json_schema: { name: "answer", schema: req.jsonSchema, strict: true } },
        }),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
      if (res.status === 429) throw new ModelError("rate_limit", "limite di richieste del fornitore", 429);
      if (!res.ok) throw new ModelError("unavailable", `HTTP ${res.status}${await errorDetail(res, this.apiKey)}`, res.status);
      // Anche la lettura del corpo rientra nel tempo concesso: un timeout qui è un timeout, non un JSON vuoto.
      body = (await res.json().catch((error: unknown) => {
        if (isTimeout(error)) throw error;
        return null;
      })) as ChatCompletion | null;
    } catch (error) {
      if (error instanceof ModelError) throw error;
      if (isTimeout(error)) throw new ModelError("timeout", `nessuna risposta entro ${req.timeoutMs} ms`);
      if (isFetchTimeout(error)) throw new ModelError("timeout", "nessuna risposta entro il limite di 5 minuti del fetch di Node (per le valutazioni locali: lib/eval-fetch.ts)");
      throw new ModelError("unavailable", `rete: ${(error as Error).message}`.slice(0, 300));
    }
    const choice = body?.choices?.[0];
    if (!choice) throw new ModelError("unavailable", "risposta del fornitore senza contenuto");
    const finish = choice.finish_reason ?? "stop";
    const u = body?.usage;
    // Consumi mancanti (alcuni servizi o server locali non li riportano): null, e il budget conta il caso peggiore.
    const reported = u && (typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number");
    const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      text: choice.message?.content ?? "",
      stop: choice.message?.refusal || finish === "content_filter" ? "refusal" : finish === "length" ? "length" : "end",
      // Nella stessa forma dei consumi di Anthropic: i token letti dalla cache sono separati da quelli nuovi.
      usage: reported
        ? {
            input_tokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
            output_tokens: u.completion_tokens ?? 0,
            cache_read_input_tokens: cached,
            cache_creation_input_tokens: 0,
          }
        : null,
      model: body?.model || this.model,
    };
  }
}

// ------------------------------------------------------------------ configurazione

export interface AskModels {
  /** Modello che risponde dalla base locale. */
  local: ModelAdapter;
  /** Client Anthropic per la ricerca web (null: ricerca non disponibile). */
  web: Anthropic | null;
  /** Tempo massimo della risposta locale in ms (ASK_TIMEOUT_MS); assente: LOCAL_TIMEOUT_MS di ask-server.ts. */
  localTimeoutMs?: number;
}

export type ModelsConfig = { ok: true; provider: string; model: string; webKey: boolean } | { ok: false; reason: string };

const clean = (v: string | undefined) => v?.trim() || undefined;

/**
 * Limiti di ASK_TIMEOUT_MS. Il massimo resta sotto il tempo della route (maxDuration 60 s, ASK_DEADLINE_MS 55 s):
 * oltre, la piattaforma interromperebbe la funzione senza risposta. Con valori sopra i 25 s di default una
 * richiesta «Approfondisci» può non avere più il tempo per la ricerca web (la guida lo dichiara).
 */
export const ASK_TIMEOUT_LIMITS = { minMs: 5_000, maxMs: 50_000 } as const;

/** ASK_TIMEOUT_MS validato: undefined se non impostato, errore leggibile se non valido. */
export function askTimeoutMs(env: Record<string, string | undefined> = process.env): { ok: true; ms: number | undefined } | { ok: false; reason: string } {
  const raw = clean(env.ASK_TIMEOUT_MS);
  if (raw === undefined) return { ok: true, ms: undefined };
  const ms = Number(raw);
  if (!/^\d+$/.test(raw) || ms < ASK_TIMEOUT_LIMITS.minMs || ms > ASK_TIMEOUT_LIMITS.maxMs) {
    return { ok: false, reason: `ASK_TIMEOUT_MS non valida: millisecondi interi da ${ASK_TIMEOUT_LIMITS.minMs} a ${ASK_TIMEOUT_LIMITS.maxMs}` };
  }
  return { ok: true, ms };
}

/** Indirizzi della macchina stessa: l'unico caso in cui un server senza chiave e senza https è accettato. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Indirizzo del servizio compatibile OpenAI: https, oppure http solo verso la macchina stessa (un server
 * locale come Ollama). Niente credenziali nell'indirizzo, niente parametri.
 */
function checkBaseUrl(raw: string): { ok: true; local: boolean } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "ASK_BASE_URL non è un indirizzo valido (es. https://servizio.example/v1)" };
  }
  const local = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return { ok: false, reason: "ASK_BASE_URL deve usare https (http è ammesso solo per un server locale: localhost, 127.0.0.1, ::1)" };
  }
  if (url.username || url.password) return { ok: false, reason: "ASK_BASE_URL non deve contenere credenziali: usa ASK_API_KEY" };
  if (url.search || url.hash) return { ok: false, reason: "ASK_BASE_URL non deve contenere parametri o frammenti" };
  return { ok: true, local };
}

/**
 * Quale modello usare, dalle variabili d'ambiente:
 * - ASK_PROVIDER: "anthropic" (default) oppure "openai-compatible";
 * - ASK_MODEL: modello della risposta locale (default claude-opus-5-5 con Anthropic; obbligatorio altrimenti);
 * - ASK_BASE_URL e ASK_API_KEY: indirizzo e chiave del servizio compatibile OpenAI; la chiave è facoltativa
 *   solo per un server locale (localhost), obbligatoria per ogni altro indirizzo;
 * - ASK_JSON_MODE: "json_schema" (default) o "json_object" (solo con il servizio compatibile OpenAI);
 * - ASK_TIMEOUT_MS: tempo massimo della risposta locale (default 25 s, vedi ASK_TIMEOUT_LIMITS);
 * - ANTHROPIC_API_KEY: chiave di Anthropic (obbligatoria con Anthropic; con l'altro fornitore abilita la ricerca web).
 * Una variabile non valida spegne le domande con un motivo leggibile (mai un ripiego silenzioso). Il motivo
 * non contiene mai i valori delle chiavi.
 */
export function modelsConfig(env: Record<string, string | undefined> = process.env): ModelsConfig {
  const provider = (clean(env.ASK_PROVIDER) ?? "anthropic").toLowerCase();
  const webKey = Boolean(clean(env.ANTHROPIC_API_KEY));
  const timeout = askTimeoutMs(env);
  if (!timeout.ok) return { ok: false, reason: timeout.reason };
  if (provider === "anthropic") {
    if (!webKey) return { ok: false, reason: "ANTHROPIC_API_KEY mancante" };
    if (clean(env.ASK_JSON_MODE) !== undefined) return { ok: false, reason: "ASK_JSON_MODE vale solo con ASK_PROVIDER=openai-compatible" };
    return { ok: true, provider, model: clean(env.ASK_MODEL) ?? DEFAULT_ANTHROPIC_MODEL, webKey };
  }
  if (provider === "openai-compatible") {
    const missing = ["ASK_BASE_URL", "ASK_MODEL"].filter((k) => !clean(env[k]));
    if (missing.length > 0) return { ok: false, reason: `variabili mancanti: ${missing.join(", ")}` };
    const base = checkBaseUrl(clean(env.ASK_BASE_URL)!);
    if (!base.ok) return { ok: false, reason: base.reason };
    if (!base.local && !clean(env.ASK_API_KEY)) return { ok: false, reason: "variabili mancanti: ASK_API_KEY (obbligatoria per un servizio non locale)" };
    const mode = clean(env.ASK_JSON_MODE);
    if (mode !== undefined && !(JSON_MODES as readonly string[]).includes(mode)) {
      return { ok: false, reason: `ASK_JSON_MODE non valida: ${JSON_MODES.join(" o ")}` };
    }
    return { ok: true, provider, model: clean(env.ASK_MODEL)!, webKey };
  }
  return { ok: false, reason: `ASK_PROVIDER sconosciuto: ${provider}` };
}

/** Crea i client secondo la configurazione (null se manca qualcosa: la guida risponde 503). */
export function modelsFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl?: FetchLike): AskModels | null {
  const config = modelsConfig(env);
  if (!config.ok) return null;
  const timeout = askTimeoutMs(env);
  // Nessun nuovo tentativo automatico dell'SDK (default 2): una chiamata scaduta può essere già pagata.
  const web = config.webKey ? new Anthropic({ apiKey: clean(env.ANTHROPIC_API_KEY), maxRetries: 0 }) : null;
  const local =
    config.provider === "anthropic"
      ? new AnthropicAdapter(web!, config.model)
      : new OpenAICompatibleAdapter(clean(env.ASK_BASE_URL)!, clean(env.ASK_API_KEY) ?? null, config.model, fetchImpl, (clean(env.ASK_JSON_MODE) as JsonMode | undefined) ?? "json_schema");
  return { local, web, ...(timeout.ok && timeout.ms !== undefined ? { localTimeoutMs: timeout.ms } : {}) };
}
