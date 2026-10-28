import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { buildBundle } from "@guide/bundle";
import { loadPacks } from "@guide/territory-pack";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ANSWER_JSON_SCHEMA, askRequestSchema, buildKnowledge, type AskRequest } from "../lib/ask.ts";
import { QuestionBudget } from "../lib/ask-cost.ts";
import { askGuide, type Loaded } from "../lib/ask-server.ts";
import { webConfig } from "../lib/ask-web.ts";
import { AnthropicAdapter, ModelError, OpenAICompatibleAdapter, modelsConfig, modelsFromEnv, type ModelRequest } from "../lib/model.ts";

const request: ModelRequest = {
  system: [{ text: "regole" }, { text: "persona" }, { text: "base", cache: true }],
  user: "domanda",
  jsonSchema: ANSWER_JSON_SCHEMA,
  maxTokens: 4000,
  timeoutMs: 25_000,
};

// ------------------------------------------------------------------ Anthropic

const anthropicReply = (o: Partial<{ text: string; stop: string; model: string }> = {}) => ({
  content: [{ type: "text", text: o.text ?? "{}" }],
  stop_reason: o.stop ?? "end_turn",
  model: o.model ?? "claude-opus-5-5",
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, server_tool_use: null },
});
function fakeAnthropic(reply: object | Error) {
  const create = vi.fn(async (_params: unknown, _options?: unknown) => {
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { client: { beta: { messages: { create } } } as unknown as Anthropic, create };
}

describe("adattatore Anthropic", () => {
  it("manda la stessa richiesta di prima: schema JSON, cache sull'ultimo blocco, ripiego lato server", async () => {
    const { client, create } = fakeAnthropic(anthropicReply({ text: '{"ok":1}' }));
    const out = await new AnthropicAdapter(client).generate(request);
    const [params, options] = create.mock.calls[0]! as [Record<string, unknown>, { timeout: number }];
    expect(params).toMatchObject({ model: "claude-opus-5-5", max_tokens: 4000, fallbacks: "default", output_config: { effort: "low", format: { type: "json_schema" } } });
    expect(params.system).toEqual([
      { type: "text", text: "regole" },
      { type: "text", text: "persona" },
      { type: "text", text: "base", cache_control: { type: "ephemeral" } },
    ]);
    expect(options).toMatchObject({ timeout: 25_000, maxRetries: 0 });
    // Consumi così come li dà l'API: li prezza il budget per domanda (lib/ask-cost.ts).
    expect(out).toMatchObject({ text: '{"ok":1}', stop: "end", model: "claude-opus-5-5", usage: { input_tokens: 100, cache_read_input_tokens: 5000, output_tokens: 20 } });
  });

  it("traduce rifiuto e troncamento", async () => {
    expect((await new AnthropicAdapter(fakeAnthropic(anthropicReply({ stop: "refusal" })).client).generate(request)).stop).toBe("refusal");
    expect((await new AnthropicAdapter(fakeAnthropic(anthropicReply({ stop: "max_tokens" })).client).generate(request)).stop).toBe("length");
  });

  it("traduce gli errori dell'API in errori del modello", async () => {
    const limit = new Anthropic.RateLimitError(429, {}, "troppe richieste", new Headers());
    await expect(new AnthropicAdapter(fakeAnthropic(limit).client).generate(request)).rejects.toMatchObject({ name: "ModelError", kind: "rate_limit" });
    const down = new Anthropic.InternalServerError(500, {}, "errore", new Headers());
    await expect(new AnthropicAdapter(fakeAnthropic(down).client).generate(request)).rejects.toMatchObject({ kind: "unavailable", status: 500 });
  });
});

// ------------------------------------------------------------------ API compatibili OpenAI

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}
const completion = (o: Partial<{ content: string; finish: string; refusal: string; cached: number }> = {}) => ({
  model: "modello-aperto-v1",
  choices: [{ finish_reason: o.finish ?? "stop", message: { content: o.content ?? '{"status":"answered"}', refusal: o.refusal ?? null } }],
  usage: { prompt_tokens: 6000, completion_tokens: 80, prompt_tokens_details: { cached_tokens: o.cached ?? 0 } },
});

describe("adattatore per API compatibili OpenAI", () => {
  it("chiama chat/completions con schema JSON e un solo messaggio di sistema", async () => {
    const fetch = fakeFetch(200, completion({ cached: 5000 }));
    const out = await new OpenAICompatibleAdapter("https://api.esempio.eu/v1/", "chiave", "modello-aperto", fetch).generate(request);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.esempio.eu/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer chiave");
    const body = JSON.parse(String(init.body));
    expect(body.messages).toEqual([
      { role: "system", content: "regole\n\npersona\n\nbase" },
      { role: "user", content: "domanda" },
    ]);
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true, schema: ANSWER_JSON_SCHEMA } });
    expect(out).toEqual({ text: '{"status":"answered"}', stop: "end", model: "modello-aperto-v1", usage: { input_tokens: 1000, output_tokens: 80, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } });
  });

  it("traduce troncamento, rifiuto e filtri", async () => {
    const run = (body: unknown) => new OpenAICompatibleAdapter("https://x.eu", "k", "m", fakeFetch(200, body)).generate(request);
    expect((await run(completion({ finish: "length" }))).stop).toBe("length");
    expect((await run(completion({ refusal: "no" }))).stop).toBe("refusal");
    expect((await run(completion({ finish: "content_filter" }))).stop).toBe("refusal");
  });

  it("traduce gli errori HTTP e di rete, senza ripetere la chiave", async () => {
    const run = (fetch: ReturnType<typeof vi.fn>) => new OpenAICompatibleAdapter("https://x.eu", "segreta", "m", fetch as never).generate(request);
    await expect(run(fakeFetch(429, {}))).rejects.toMatchObject({ kind: "rate_limit" });
    await expect(run(fakeFetch(503, {}))).rejects.toMatchObject({ kind: "unavailable", status: 503 });
    await expect(run(fakeFetch(200, { choices: [] }))).rejects.toBeInstanceOf(ModelError);
    const offline = vi.fn(async () => {
      throw new Error("connessione rifiutata");
    });
    const error = await run(offline).catch((e: Error) => e);
    expect(error).toMatchObject({ kind: "unavailable" });
    expect((error as Error).message).not.toContain("segreta");
  });
});

// ------------------------------------------------------------------ configurazione

describe("configurazione del modello", () => {
  it("per default usa Anthropic e richiede la sua chiave", () => {
    expect(modelsConfig({})).toMatchObject({ ok: false });
    expect(modelsConfig({ ANTHROPIC_API_KEY: "k" })).toEqual({ ok: true, provider: "anthropic", model: "claude-opus-5-5", webKey: true });
    expect(modelsConfig({ ANTHROPIC_API_KEY: "k", ASK_MODEL: "claude-sonnet-5-5" })).toMatchObject({ model: "claude-sonnet-5-5" });
  });

  it("con un fornitore compatibile OpenAI servono indirizzo, chiave e modello", () => {
    expect(modelsConfig({ ASK_PROVIDER: "openai-compatible", ASK_MODEL: "m" })).toMatchObject({ ok: false, reason: expect.stringContaining("ASK_BASE_URL") });
    const env = { ASK_PROVIDER: "openai-compatible", ASK_BASE_URL: "https://x.eu/v1", ASK_API_KEY: "k", ASK_MODEL: "m" };
    expect(modelsConfig(env)).toEqual({ ok: true, provider: "openai-compatible", model: "m", webKey: false });
    expect(modelsConfig({ ASK_PROVIDER: "altro" })).toMatchObject({ ok: false });
  });

  it("la ricerca web resta disponibile solo con la chiave di Anthropic", () => {
    const env = { ASK_PROVIDER: "openai-compatible", ASK_BASE_URL: "https://x.eu/v1", ASK_API_KEY: "k", ASK_MODEL: "m" };
    const independent = modelsFromEnv(env)!;
    expect(independent.local.provider).toBe("openai-compatible");
    expect(independent.web).toBeNull();
    expect(modelsFromEnv({ ...env, ANTHROPIC_API_KEY: "a" })!.web).not.toBeNull();
    expect(modelsFromEnv({})).toBeNull();
  });
});

// ------------------------------------------------------------------ guida con un altro fornitore

describe("risposta con un fornitore diverso da Anthropic", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  let loaded: Loaded;
  let req: AskRequest;
  beforeAll(() => {
    const { packs } = loadPacks(resolve(here, "../../../territories/_synthetic"));
    const dest = [...packs.values()].find((p) => p.manifest.kind === "destination")!;
    const content = buildBundle(packs, { destination: dest.manifest.id, locale: "it", allowFictional: true }).content;
    loaded = { content, knowledge: buildKnowledge(content), kbHash: "kb-test" };
    req = askRequestSchema.parse({ destination: content.destination, locale: "it", question: "Perché fu costruito qui?" });
  });

  it("controlla la risposta con le stesse regole e, senza ricerca, risponde con la sola base", async () => {
    const ref = loaded.content.assertions[0]!.ref;
    const fetch = fakeFetch(200, completion({ content: JSON.stringify({ status: "partial", answer: "So solo questo.", citations: [ref] }) }));
    const ai = { local: new OpenAICompatibleAdapter("https://x.eu", "k", "m", fetch), web: null };
    const out = await askGuide(ai, loaded, req, { config: webConfig({}), supported: true, permitted: () => true }, new QuestionBudget(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out.answer).toMatchObject({ status: "partial", origin: "local", citations: [ref] });
    expect(out.web).toBeUndefined();
    // Nessun listino per un modello sconosciuto: qualità "unknown", costo contato con le tariffe prudenti, mai zero.
    expect(out.costQuality).toBe("unknown");
    expect(out.costUsd).toBeGreaterThan(0);
  });

  it("una risposta inventata viene scartata anche dal modello aperto", async () => {
    const fetch = fakeFetch(200, completion({ content: JSON.stringify({ status: "answered", answer: "Fu costruito nel 1312.", citations: [loaded.content.assertions[0]!.ref] }) }));
    const out = await askGuide({ local: new OpenAICompatibleAdapter("https://x.eu", "k", "m", fetch), web: null }, loaded, req, null, new QuestionBudget(1));
    expect(out.answer.status).toBe("rejected");
    expect(out.rejected).toContain("1312");
  });
});
