/**
 * Modello linguistico dietro un'interfaccia: la risposta dalla base locale non dipende dal fornitore.
 *
 * - AnthropicAdapter: il comportamento di sempre (structured output, cache del prompt, ripiego lato server).
 * - OpenAICompatibleAdapter: qualunque servizio con l'API "chat completions" (Mistral, vLLM, servizi
 *   gestiti di modelli aperti…), con output JSON vincolato dallo schema. Nessuna dipendenza in più: usa fetch.
 *
 * La ricerca web (ask-web.ts) resta uno strumento lato server di Anthropic: con un altro fornitore la
 * guida risponde con la sola base locale, a meno che sia configurata anche la chiave di Anthropic.
 * Configurazione dalle variabili d'ambiente (modelsFromEnv), nessun segreto nei log.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Usage } from "./ask-web";

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
  usage: Usage;
  /** Modello che ha risposto davvero (con un ripiego può non essere quello richiesto). */
  model: string;
}

export interface ModelAdapter {
  readonly provider: string;
  readonly model: string;
  generate(req: ModelRequest): Promise<ModelResponse>;
}

/** Errore del fornitore, nella forma che serve alla route (nessun segreto nel messaggio). */
export class ModelError extends Error {
  constructor(
    readonly kind: "rate_limit" | "unavailable",
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
        { timeout: req.timeoutMs },
      );
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) throw new ModelError("rate_limit", "limite di richieste del fornitore", 429);
      if (error instanceof Anthropic.APIError) throw new ModelError("unavailable", `API ${error.status ?? "?"}: ${error.message}`.slice(0, 300), error.status);
      throw error;
    }
    const u = response.usage;
    return {
      text: response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
      stop: response.stop_reason === "refusal" ? "refusal" : response.stop_reason === "max_tokens" ? "length" : "end",
      usage: {
        input: u.input_tokens,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens,
        webSearches: u.server_tool_use?.web_search_requests ?? 0,
      },
      model: response.model || this.model,
    };
  }
}

// ------------------------------------------------------------------ API compatibili OpenAI

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface ChatCompletion {
  model?: string;
  choices?: { finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null };
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly provider = "openai-compatible";
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    readonly model: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          max_tokens: req.maxTokens,
          temperature: 0.3,
          // Un solo messaggio di sistema: il prefisso resta identico tra le richieste (cache dove il servizio la offre).
          messages: [
            { role: "system", content: req.system.map((b) => b.text).join("\n\n") },
            { role: "user", content: req.user },
          ],
          response_format: { type: "json_schema", json_schema: { name: "answer", schema: req.jsonSchema, strict: true } },
        }),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
    } catch (error) {
      throw new ModelError("unavailable", `rete: ${(error as Error).message}`.slice(0, 300));
    }
    if (res.status === 429) throw new ModelError("rate_limit", "limite di richieste del fornitore", 429);
    if (!res.ok) throw new ModelError("unavailable", `HTTP ${res.status}`, res.status);
    const body = (await res.json().catch(() => null)) as ChatCompletion | null;
    const choice = body?.choices?.[0];
    if (!choice) throw new ModelError("unavailable", "risposta del fornitore senza contenuto");
    const cached = body?.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const finish = choice.finish_reason ?? "stop";
    return {
      text: choice.message?.content ?? "",
      stop: choice.message?.refusal || finish === "content_filter" ? "refusal" : finish === "length" ? "length" : "end",
      usage: {
        input: Math.max(0, (body?.usage?.prompt_tokens ?? 0) - cached),
        cacheWrite: 0,
        cacheRead: cached,
        output: body?.usage?.completion_tokens ?? 0,
        webSearches: 0,
      },
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
}

export type ModelsConfig = { ok: true; provider: string; model: string; webKey: boolean } | { ok: false; reason: string };

const clean = (v: string | undefined) => v?.trim() || undefined;

/**
 * Quale modello usare, dalle variabili d'ambiente:
 * - ASK_PROVIDER: "anthropic" (default) oppure "openai-compatible";
 * - ASK_MODEL: modello della risposta locale (default claude-opus-5-5 con Anthropic; obbligatorio altrimenti);
 * - ASK_BASE_URL e ASK_API_KEY: indirizzo e chiave del servizio compatibile OpenAI;
 * - ANTHROPIC_API_KEY: chiave di Anthropic (obbligatoria con Anthropic; con l'altro fornitore abilita la ricerca web).
 */
export function modelsConfig(env: Record<string, string | undefined> = process.env): ModelsConfig {
  const provider = (clean(env.ASK_PROVIDER) ?? "anthropic").toLowerCase();
  const webKey = Boolean(clean(env.ANTHROPIC_API_KEY));
  if (provider === "anthropic") {
    if (!webKey) return { ok: false, reason: "ANTHROPIC_API_KEY mancante" };
    return { ok: true, provider, model: clean(env.ASK_MODEL) ?? DEFAULT_ANTHROPIC_MODEL, webKey };
  }
  if (provider === "openai-compatible") {
    const missing = ["ASK_BASE_URL", "ASK_API_KEY", "ASK_MODEL"].filter((k) => !clean(env[k]));
    if (missing.length > 0) return { ok: false, reason: `variabili mancanti: ${missing.join(", ")}` };
    return { ok: true, provider, model: clean(env.ASK_MODEL)!, webKey };
  }
  return { ok: false, reason: `ASK_PROVIDER sconosciuto: ${provider}` };
}

/** Crea i client secondo la configurazione (null se manca qualcosa: la guida risponde 503). */
export function modelsFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl?: FetchLike): AskModels | null {
  const config = modelsConfig(env);
  if (!config.ok) return null;
  const web = config.webKey ? new Anthropic({ apiKey: clean(env.ANTHROPIC_API_KEY) }) : null;
  const local =
    config.provider === "anthropic"
      ? new AnthropicAdapter(web!, config.model)
      : new OpenAICompatibleAdapter(clean(env.ASK_BASE_URL)!, clean(env.ASK_API_KEY)!, config.model, fetchImpl);
  return { local, web };
}
