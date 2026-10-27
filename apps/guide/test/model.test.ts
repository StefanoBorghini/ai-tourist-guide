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

// ------------------------------------------------------------------ fornitori alternativi (fase B)

describe("adattatore compatibile OpenAI: server locali e servizi parziali", () => {
  it("senza chiave non manda l'intestazione di autenticazione (server locale)", async () => {
    const fetch = fakeFetch(200, completion());
    await new OpenAICompatibleAdapter("http://localhost:11434/v1", null, "modello-locale", fetch).generate(request);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect(init.headers as Record<string, string>).not.toHaveProperty("authorization");
  });

  it("json_schema resta il formato predefinito; json_object chiede solo JSON e mette lo schema come istruzione di formato", async () => {
    const strict = fakeFetch(200, completion());
    await new OpenAICompatibleAdapter("https://x.eu", "k", "m", strict).generate(request);
    expect(JSON.parse(String(strict.mock.calls[0]![1].body)).response_format.type).toBe("json_schema");
    const loose = fakeFetch(200, completion());
    await new OpenAICompatibleAdapter("https://x.eu", "k", "m", loose, "json_object").generate(request);
    const body = JSON.parse(String(loose.mock.calls[0]![1].body));
    expect(body.response_format).toEqual({ type: "json_object" });
    // Le istruzioni di Gaia restano identiche e in testa; il formato si aggiunge in fondo.
    expect(body.messages[0].content.startsWith("regole\n\npersona\n\nbase\n\nFORMATO DELLA RISPOSTA")).toBe(true);
    expect(body.messages[0].content).toContain(JSON.stringify(ANSWER_JSON_SCHEMA));
  });

  it("un tempo scaduto è un errore «timeout», distinto dagli altri, anche durante la lettura della risposta", async () => {
    // Fetch che resta in attesa finché il segnale non scade, come un server lento.
    const slow = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    const error = await new OpenAICompatibleAdapter("http://127.0.0.1:11434/v1", null, "m", slow).generate({ ...request, timeoutMs: 30 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ModelError", kind: "timeout" });
    const bodyTimeout = vi.fn(async () => ({ ok: true, status: 200, json: async () => Promise.reject(new DOMException("scaduto", "TimeoutError")) }) as unknown as Response);
    await expect(new OpenAICompatibleAdapter("https://x.eu", "k", "m", bodyTimeout).generate(request)).rejects.toMatchObject({ kind: "timeout" });
    const refused = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(new OpenAICompatibleAdapter("https://x.eu", "k", "m", refused).generate(request)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("errore HTTP: il motivo scritto dal servizio entra nel messaggio, accorciato e senza la chiave", async () => {
    const ollamaError = fakeFetch(500, { error: "failed to parse JSON grammar" });
    await expect(new OpenAICompatibleAdapter("http://localhost:11434/v1", null, "m", ollamaError).generate(request)).rejects.toMatchObject({ kind: "unavailable", status: 500, message: "HTTP 500: failed to parse JSON grammar" });
    const openaiStyle = fakeFetch(400, { error: { message: "chiave k-segreta non valida", type: "invalid_request_error" } });
    const e = (await new OpenAICompatibleAdapter("https://x.eu", "k-segreta", "m", openaiStyle).generate(request).catch((x: unknown) => x)) as Error;
    expect(e.message).toBe("HTTP 400: chiave [chiave] non valida");
    const long = vi.fn(async () => new Response(`errore\n${"x".repeat(1000)}`, { status: 503 }));
    const m = ((await new OpenAICompatibleAdapter("https://x.eu", "k", "m", long).generate(request).catch((x: unknown) => x)) as Error).message;
    expect(m.startsWith("HTTP 503: errore x")).toBe(true);
    expect(m.length).toBeLessThanOrEqual("HTTP 503: ".length + 200);
    const empty = vi.fn(async () => new Response("", { status: 502 }));
    await expect(new OpenAICompatibleAdapter("https://x.eu", "k", "m", empty).generate(request)).rejects.toMatchObject({ message: "HTTP 502" });
  });

  it("corpo non JSON o senza scelte: errore del fornitore, mai una risposta vuota accettata", async () => {
    const html = vi.fn(async () => new Response("<html>errore</html>", { status: 200 }));
    await expect(new OpenAICompatibleAdapter("https://x.eu", "k", "m", html).generate(request)).rejects.toMatchObject({ kind: "unavailable" });
    await expect(new OpenAICompatibleAdapter("https://x.eu", "k", "m", fakeFetch(200, { choices: [] })).generate(request)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("consumi non riportati dal servizio: usage null (non zero)", async () => {
    const { usage: _u, ...noUsage } = completion();
    const out = await new OpenAICompatibleAdapter("https://x.eu", "k", "m", fakeFetch(200, noUsage)).generate(request);
    expect(out.usage).toBeNull();
    const empty = await new OpenAICompatibleAdapter("https://x.eu", "k", "m", fakeFetch(200, { ...noUsage, usage: {} })).generate(request);
    expect(empty.usage).toBeNull();
  });

  it("Anthropic: il tempo scaduto dell'SDK diventa «timeout»", async () => {
    const timeout = new Anthropic.APIConnectionTimeoutError();
    await expect(new AnthropicAdapter(fakeAnthropic(timeout).client).generate(request)).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("configurazione dei fornitori alternativi", () => {
  const compat = { ASK_PROVIDER: "openai-compatible", ASK_MODEL: "m" };

  it("senza variabili nuove il comportamento resta quello di prima", () => {
    expect(modelsConfig({ ANTHROPIC_API_KEY: "k" })).toEqual({ ok: true, provider: "anthropic", model: "claude-opus-5-5", webKey: true });
    const ai = modelsFromEnv({ ANTHROPIC_API_KEY: "k" })!;
    expect(ai.local.provider).toBe("anthropic");
    expect(ai.localTimeoutMs).toBeUndefined();
  });

  it("server locale senza chiave: ammesso solo per localhost, 127.0.0.1 e ::1", () => {
    for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:11434/v1", "http://[::1]:11434/v1"]) {
      expect(modelsConfig({ ...compat, ASK_BASE_URL: url }), url).toEqual({ ok: true, provider: "openai-compatible", model: "m", webKey: false });
    }
    const ai = modelsFromEnv({ ...compat, ASK_BASE_URL: "http://localhost:11434/v1" })!;
    expect(ai.local.provider).toBe("openai-compatible");
    expect(ai.web).toBeNull();
  });

  it("servizio remoto: https e chiave obbligatori, niente credenziali o parametri nell'indirizzo", () => {
    expect(modelsConfig({ ...compat, ASK_BASE_URL: "https://x.eu/v1" })).toMatchObject({ ok: false, reason: expect.stringContaining("ASK_API_KEY") });
    expect(modelsConfig({ ...compat, ASK_BASE_URL: "http://x.eu/v1", ASK_API_KEY: "k" })).toMatchObject({ ok: false, reason: expect.stringContaining("https") });
    expect(modelsConfig({ ...compat, ASK_BASE_URL: "http://192.168.1.10:11434/v1" })).toMatchObject({ ok: false });
    expect(modelsConfig({ ...compat, ASK_BASE_URL: "non un indirizzo", ASK_API_KEY: "k" })).toMatchObject({ ok: false, reason: expect.stringContaining("ASK_BASE_URL") });
    expect(modelsConfig({ ...compat, ASK_BASE_URL: "https://utente:segreta@x.eu/v1", ASK_API_KEY: "k" })).toMatchObject({ ok: false, reason: expect.stringContaining("credenziali") });
    expect(modelsConfig({ ...compat, ASK_BASE_URL: "https://x.eu/v1?key=segreta", ASK_API_KEY: "k" })).toMatchObject({ ok: false });
    expect(modelsConfig({ ...compat, ASK_BASE_URL: "ftp://x.eu/v1", ASK_API_KEY: "k" })).toMatchObject({ ok: false });
  });

  it("ASK_JSON_MODE: due valori ammessi, solo con il fornitore compatibile OpenAI", () => {
    const env = { ...compat, ASK_BASE_URL: "http://localhost:11434/v1" };
    expect(modelsConfig({ ...env, ASK_JSON_MODE: "json_object" })).toMatchObject({ ok: true });
    expect(modelsConfig({ ...env, ASK_JSON_MODE: "json_schema" })).toMatchObject({ ok: true });
    expect(modelsConfig({ ...env, ASK_JSON_MODE: "testo" })).toMatchObject({ ok: false, reason: expect.stringContaining("ASK_JSON_MODE") });
    expect(modelsConfig({ ANTHROPIC_API_KEY: "k", ASK_JSON_MODE: "json_object" })).toMatchObject({ ok: false, reason: expect.stringContaining("ASK_JSON_MODE") });
  });

  it("ASK_TIMEOUT_MS: intero da 5000 a 50000; un valore non valido spegne le domande con un motivo leggibile", () => {
    expect(modelsFromEnv({ ANTHROPIC_API_KEY: "k", ASK_TIMEOUT_MS: "40000" })!.localTimeoutMs).toBe(40_000);
    for (const bad of ["4999", "50001", "30s", "-1", "2.5"]) {
      expect(modelsConfig({ ANTHROPIC_API_KEY: "k", ASK_TIMEOUT_MS: bad }), bad).toMatchObject({ ok: false, reason: expect.stringContaining("ASK_TIMEOUT_MS") });
      expect(modelsFromEnv({ ANTHROPIC_API_KEY: "k", ASK_TIMEOUT_MS: bad })).toBeNull();
    }
  });

  it("i motivi degli errori non contengono mai le chiavi", () => {
    const secret = "sk-segretissima-123";
    const cases = [
      { ...compat, ASK_BASE_URL: "http://x.eu/v1", ASK_API_KEY: secret },
      { ...compat, ASK_BASE_URL: "https://x.eu/v1", ASK_API_KEY: secret, ASK_JSON_MODE: "boh" },
      { ANTHROPIC_API_KEY: secret, ASK_TIMEOUT_MS: "1" },
    ];
    for (const env of cases) {
      const r = modelsConfig(env);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(secret);
    }
  });
});

describe("guida con un fornitore che non riporta i consumi o con un tempo diverso", () => {
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

  it("consumi mancanti: il budget conta il caso peggiore stimato, mai zero", async () => {
    const ref = loaded.content.assertions[0]!.ref;
    const { usage: _u, ...noUsage } = completion({ content: JSON.stringify({ status: "partial", answer: "So solo questo.", citations: [ref] }) });
    const ai = { local: new OpenAICompatibleAdapter("http://localhost:11434/v1", null, "modello-locale", fakeFetch(200, noUsage)), web: null };
    const budget = new QuestionBudget(1);
    const out = await askGuide(ai, loaded, req, null, budget);
    expect(out.answer).toMatchObject({ status: "partial", origin: "local" });
    expect(out.costUsd).toBeGreaterThan(0);
    expect(out.costUsd).toBe(budget.calls[0]!.usd);
    expect(out.costQuality).toBe("unknown");
    expect(budget.calls[0]).toMatchObject({ outcome: "ok", usage: null });
  });

  it("il budget resta un limite anche per un modello senza listino: con un budget troppo basso nessuna chiamata", async () => {
    const fetch = fakeFetch(200, completion());
    const ai = { local: new OpenAICompatibleAdapter("http://localhost:11434/v1", null, "modello-locale", fetch), web: null };
    const out = await askGuide(ai, loaded, req, null, new QuestionBudget(0.001));
    expect(fetch).not.toHaveBeenCalled();
    expect(out.answer.status).toBe("unavailable");
  });

  it("ASK_TIMEOUT_MS arriva all'adattatore; senza, resta il default di 25 s", async () => {
    const seen: number[] = [];
    const local = {
      provider: "finto",
      model: "claude-haiku-5-5",
      generate: async (r: ModelRequest) => {
        seen.push(r.timeoutMs);
        return { text: JSON.stringify({ status: "off_topic", answer: "Parliamo della visita.", citations: [] }), stop: "end" as const, usage: { input_tokens: 10, output_tokens: 10 }, model: "claude-haiku-5-5" };
      },
    };
    await askGuide({ local, web: null, localTimeoutMs: 40_000 }, loaded, req, null, new QuestionBudget(1));
    await askGuide({ local, web: null }, loaded, req, null, new QuestionBudget(1));
    expect(seen).toEqual([40_000, 25_000]);
  });
});
