import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { buildBundle } from "@guide/bundle";
import { loadPacks } from "@guide/territory-pack";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ANSWER_JSON_SCHEMA, SYSTEM_PROMPT, askRequestSchema, buildKnowledge, buildQuestionMessage, type AskRequest } from "../lib/ask.ts";
import {
  CONSERVATIVE_RATES,
  QuestionBudget,
  SEARCH_RESULT_TOKENS_ALLOWANCE,
  estimateInputTokens,
  estimateUsd,
  nextContextTokens,
  questionBudgetConfig,
  ratesFor,
  usageParts,
} from "../lib/ask-cost.ts";
import { aggregateScores, blindKey, emptyScore, percentile, stats } from "../lib/ask-eval-stats.ts";
import { LOCAL_MAX_TOKENS, LOCAL_MIN_TOKENS, WEB_MAX_TOKENS, WEB_MIN_TOKENS, askGuide, type Loaded, type WebGate } from "../lib/ask-server.ts";
import { WEB_SYSTEM_PROMPT, buildWebAddendum, webConfig, type ContentBlockLike } from "../lib/ask-web.ts";
import { AnthropicAdapter, type AskModels } from "../lib/model.ts";
import { PERSONA_PROMPT } from "../lib/persona.ts";

/** Prove sul bundle del territorio di test, senza nomi di territorio scritti qui. Nessuna chiamata reale. */
const here = dirname(fileURLToPath(import.meta.url));
let loaded: Loaded;
let req: AskRequest;
let ref: string;

beforeAll(() => {
  const { packs } = loadPacks(resolve(here, "../../../territories/_synthetic"));
  const dest = [...packs.values()].find((p) => p.manifest.kind === "destination")!;
  const content = buildBundle(packs, { destination: dest.manifest.id, locale: "it", allowFictional: true }).content;
  loaded = { content, knowledge: buildKnowledge(content), kbHash: "kb-test" };
  req = askRequestSchema.parse({ destination: content.destination, locale: "it", question: "Perché fu costruito qui?" });
  ref = content.assertions[0]!.ref;
});

// ------------------------------------------------------------------ API simulata

type UsageOpts = Partial<{ input: number; output: number; searches: number; iterations: object[] }>;
const usage = (o: UsageOpts = {}) => ({
  input_tokens: o.input ?? 1000,
  output_tokens: o.output ?? 100,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  server_tool_use: o.searches === undefined ? null : { web_search_requests: o.searches, web_fetch_requests: 0 },
  ...(o.iterations ? { iterations: o.iterations } : {}),
});
const localReply = (status: string, answer = "Risposta.", citations: string[] = [], u: UsageOpts = {}, model?: string) => ({
  content: [{ type: "text", text: JSON.stringify({ status, answer, citations }) }],
  stop_reason: "end_turn",
  usage: usage(u),
  ...(model ? { model } : {}),
});
const cite = (url: string) => ({ type: "web_search_result_location", url, title: "Fonte", cited_text: "brano", encrypted_index: "x" });
const searchBlocks: ContentBlockLike[] = [
  { type: "server_tool_use", name: "web_search", input: { query: "q" } } as ContentBlockLike,
  { type: "web_search_tool_result", content: [{ type: "web_search_result", encrypted_content: "e", url: "https://www.comune.esempio.it/a", title: "A" }] },
];
const webReply = (stop: "end_turn" | "pause_turn", u: UsageOpts = {}) => ({
  content: stop === "pause_turn" ? searchBlocks : [{ type: "text", text: "Risposta dal web.", citations: [cite("https://www.comune.esempio.it/a")] }],
  stop_reason: stop,
  usage: usage({ input: 8000, output: 600, searches: 1, ...u }),
});

function fakeClient(...replies: (object | Error)[]) {
  const create = vi.fn(async (_params: unknown, _options?: unknown) => {
    const next = replies.shift();
    if (!next) throw new Error("nessuna risposta prevista");
    if (next instanceof Error) throw next;
    return next;
  });
  const anthropic = { beta: { messages: { create } } } as unknown as Anthropic;
  const client: AskModels = { local: new AnthropicAdapter(anthropic), web: anthropic };
  return { client, create };
}
const params = (create: ReturnType<typeof fakeClient>["create"], i: number) =>
  create.mock.calls[i]![0] as { model: string; max_tokens: number; tools?: { max_uses: number }[] };
const options = (create: ReturnType<typeof fakeClient>["create"], i: number) => create.mock.calls[i]![1] as { maxRetries?: number; timeout?: number };
const gate = (env: Record<string, string> = {}): WebGate => ({ config: webConfig(env), supported: true, permitted: () => true });

/** Caso peggiore della risposta locale piena (come lo calcola il budget). */
const localInputTokens = (r: AskRequest = req) =>
  estimateInputTokens(SYSTEM_PROMPT, PERSONA_PROMPT, loaded.knowledge, buildQuestionMessage(loaded.content, r), JSON.stringify(ANSWER_JSON_SCHEMA));

// ------------------------------------------------------------------ configurazione (caso 11)

describe("configurazione del budget per domanda", () => {
  it("accetta solo un numero positivo in dollari con il punto", () => {
    expect(questionBudgetConfig({ ASK_MAX_USD_PER_QUESTION: "0.15" })).toEqual({ ok: true, maxUsd: 0.15 });
    expect(questionBudgetConfig({ ASK_MAX_USD_PER_QUESTION: " 2 " })).toEqual({ ok: true, maxUsd: 2 });
  });
  it("assente, vuota, non numerica, negativa, zero o scritta male: domande spente, mai un default", () => {
    for (const v of [undefined, "", "  ", "abc", "-1", "0", "0.0", "0,15", "1e3", "Infinity", "NaN", "0.15$"]) {
      const c = questionBudgetConfig({ ASK_MAX_USD_PER_QUESTION: v });
      expect(c.ok, String(v)).toBe(false);
    }
    expect(() => new QuestionBudget(0)).toThrow();
    expect(() => new QuestionBudget(Number.NaN)).toThrow();
  });
});

// ------------------------------------------------------------------ listino e consumi

describe("listino e consumi", () => {
  it("tariffe verificate: Opus 5.5, Sonnet 5.5 (lettura cache 0,20), Haiku 5.5 a due fasce, ripieghi", () => {
    expect(ratesFor("claude-opus-5-5")).toEqual({ input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 });
    expect(ratesFor("claude-sonnet-5-5")?.cacheRead).toBe(0.2);
    expect(ratesFor("claude-haiku-5-5", 100_000)?.input).toBe(0.1);
    expect(ratesFor("claude-haiku-5-5", 100_001)?.input).toBe(0.5);
    expect(ratesFor("claude-opus-4-8")?.output).toBe(25);
    expect(ratesFor("claude-opus-4-8-20260101")?.output).toBe(25);
    expect(ratesFor("claude-opus-5-5-preview")).toBeNull();
    expect(ratesFor("modello-sconosciuto")).toBeNull();
  });
  it("stima a listino; fascia di Haiku scelta dalla dimensione del prompt", () => {
    expect(estimateUsd("claude-opus-5-5", { input: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 0, webSearches: 0 })).toBe(4);
    expect(estimateUsd("claude-haiku-5-5", { input: 200_000, cacheWrite: 0, cacheRead: 0, output: 0, webSearches: 0 })).toBe(0.1);
    expect(estimateUsd("modello-sconosciuto", { input: 1, cacheWrite: 0, cacheRead: 0, output: 0, webSearches: 0 })).toBeNull();
  });
  it("divide i consumi per passaggio e per modello; senza passaggi usa il totale", () => {
    const u = {
      input_tokens: 2000,
      output_tokens: 100,
      server_tool_use: { web_search_requests: 2 },
      iterations: [
        { type: "message", model: null, input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ],
    };
    const parts = usageParts(u, "claude-opus-4-8", "claude-opus-5-5");
    expect(parts.map((p) => p.model)).toEqual(["claude-opus-5-5", "claude-opus-4-8"]);
    expect(parts[1]!.usage.webSearches).toBe(2);
    expect(usageParts({ input_tokens: 5, output_tokens: 1 }, "claude-opus-5-5", "claude-opus-5-5")).toHaveLength(1);
    expect(nextContextTokens(u)).toBe(1100);
    expect(nextContextTokens({ input_tokens: 70, output_tokens: 30 })).toBe(100);
  });
  it("il piano conta l'ingresso al prezzo più alto, la stima dei risultati e riduce le ricerche prima di rinunciare", () => {
    const b = new QuestionBudget(0.2);
    const p = b.plan({ model: "claude-opus-5-5", inputTokens: 10_000, maxTokens: 6000, minTokens: 1500, searches: 3, minSearches: 1 });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    // 3 ricerche: (10.000 + 30.000) × 5 $/M = 0,20 $ → non ci stanno; 2: 0,15 + 0,02 → 1.500 token a 20 $/M = 0,03 → 0,20: ci stanno appena.
    expect(p.searches).toBe(2);
    expect(p.maxTokens).toBeGreaterThanOrEqual(1500);
    expect(p.worstUsd).toBeLessThanOrEqual(0.2);
    expect(SEARCH_RESULT_TOKENS_ALLOWANCE).toBeGreaterThan(0);
    // Modello fuori listino: tariffe più alte, mai zero.
    const u = b.plan({ model: "modello-sconosciuto", inputTokens: 1000, maxTokens: 1000, minTokens: 100 });
    expect(u.ok && u.worstUsd).toBeGreaterThan((1000 * CONSERVATIVE_RATES.input) / 1e6);
  });
});

// ------------------------------------------------------------------ budget sul percorso reale (casi 1–10, 13)

describe("budget per domanda", () => {
  it("1. una domanda locale entro il budget: una chiamata, max_tokens pieno, costo misurato", async () => {
    const { client, create } = fakeClient(localReply("answered", "Dalla base.", [ref]));
    const budget = new QuestionBudget(1);
    const out = await askGuide(client, loaded, req, gate(), budget);
    expect(create).toHaveBeenCalledTimes(1);
    expect(params(create, 0).max_tokens).toBe(LOCAL_MAX_TOKENS);
    expect(out.answer).toMatchObject({ status: "answered", origin: "local" });
    expect(out.costQuality).toBe("measured");
    // 1000 in × 4 + 100 out × 20, per milione
    expect(out.costUsd).toBeCloseTo(0.006, 6);
    expect(out.budget).toMatchObject({ limitUsd: 1, spentUsd: out.costUsd, calls: 1 });
    expect(out.budget.stop).toBeUndefined();
  });

  it("2. se nemmeno la risposta minima ci sta, nessuna chiamata e risposta controllata", async () => {
    const { client, create } = fakeClient();
    const budget = new QuestionBudget(0.001);
    const out = await askGuide(client, loaded, req, gate(), budget);
    expect(create).not.toHaveBeenCalled();
    expect(out.answer.status).toBe("unavailable");
    // Il visitatore non vede dettagli interni (budget, cifre).
    expect(out.answer.answer).not.toMatch(/budget|\$|usd/i);
    expect(out.budget.stop).toMatch(/risposta locale non avviata/);
    expect(out.costUsd).toBe(0);
  });

  it("3. max_tokens si riduce al residuo quando il limite pieno non ci sta", async () => {
    const fixed = (localInputTokens() * 5) / 1e6;
    const limit = fixed + (2000 * 20) / 1e6 + 1e-6;
    const { client, create } = fakeClient(localReply("answered", "Dalla base.", [ref]));
    await askGuide(client, loaded, req, gate(), new QuestionBudget(limit));
    const max = params(create, 0).max_tokens;
    expect(max).toBeLessThan(LOCAL_MAX_TOKENS);
    expect(max).toBeGreaterThanOrEqual(LOCAL_MIN_TOKENS);
    expect(max).toBeGreaterThanOrEqual(1990);
    expect(max).toBeLessThanOrEqual(2000);
  });

  it("4. con ASK_WEB_MAX_USES=1 si concede una ricerca e, dopo una pausa, nessun altro giro", async () => {
    const { client, create } = fakeClient(localReply("not_in_knowledge", "Non lo so."), webReply("pause_turn"), webReply("end_turn"));
    const out = await askGuide(client, loaded, req, gate({ ASK_WEB_MAX_USES: "1" }), new QuestionBudget(5));
    expect(create).toHaveBeenCalledTimes(2);
    expect(params(create, 1).tools?.[0]?.max_uses).toBe(1);
    expect(out.usage.web?.webSearches).toBe(1);
    expect(out.web).toMatchObject({ rounds: 1, searches: 1 });
    expect(out.answer.webUnavailable).toBe(true);
  });

  it("5. con ASK_WEB_MAX_USES=3 il totale resta tre, anche attraverso le pause", async () => {
    const { client, create } = fakeClient(
      localReply("not_in_knowledge", "Non lo so."),
      webReply("pause_turn", { searches: 2 }),
      webReply("pause_turn", { searches: 1 }),
      webReply("end_turn"),
    );
    const out = await askGuide(client, loaded, req, gate({ ASK_WEB_MAX_USES: "3" }), new QuestionBudget(5));
    // Dopo 3 ricerche non parte un quarto giro.
    expect(create).toHaveBeenCalledTimes(3);
    expect(params(create, 1).tools?.[0]?.max_uses).toBe(3);
    expect(params(create, 2).tools?.[0]?.max_uses).toBe(1);
    expect(out.usage.web?.webSearches).toBe(3);
    expect(params(create, 1).max_tokens).toBeLessThanOrEqual(WEB_MAX_TOKENS);
  });

  it("6. un giro successivo non parte se il budget è esaurito", async () => {
    const { client, create } = fakeClient(localReply("not_in_knowledge", "Non lo so."), webReply("pause_turn", { input: 60_000 }));
    const budget = new QuestionBudget(0.5);
    const out = await askGuide(client, loaded, req, gate(), budget);
    expect(create).toHaveBeenCalledTimes(2);
    expect(out.budget.stop).toMatch(/giro 2/);
    expect(out.answer).toMatchObject({ origin: "local", webUnavailable: true });
    // Speso: locale 0,006 + primo giro (60.000 × 4 + 600 × 20)/1e6 + 0,01
    expect(out.costUsd).toBeCloseTo(0.006 + 0.24 + 0.012 + 0.01, 5);
    expect(out.costUsd).toBeLessThanOrEqual(budget.limitUsd);
  });

  it("7. errore della ricerca nell'approfondimento: il ripiego locale resta nel budget (riserva)", async () => {
    const { client, create } = fakeClient(new Error("socket hang up"), localReply("answered", "Dalla base.", [ref]));
    const budget = new QuestionBudget(0.6);
    const out = await askGuide(client, loaded, { ...req, depth: "deep" }, gate(), budget);
    expect(create).toHaveBeenCalledTimes(2);
    expect(params(create, 0).tools).toHaveLength(1);
    // La ricerca fallita conta il suo caso peggiore (stima), il ripiego ci sta comunque.
    expect(out.calls[0]).toMatchObject({ kind: "web", outcome: "error", quality: "estimated" });
    expect(out.calls[0]!.usd).toBeGreaterThan(0);
    expect(out.calls[1]).toMatchObject({ kind: "local", outcome: "ok" });
    expect(out.answer).toMatchObject({ origin: "local", webUnavailable: true });
    expect(out.costUsd).toBeLessThanOrEqual(budget.limitUsd);
    expect(out.costQuality).toBe("estimated");
  });

  it("7b. nel percorso normale l'errore della ricerca non ripaga la risposta locale", async () => {
    const { client, create } = fakeClient(localReply("partial", "In parte.", [ref]), new Error("socket hang up"));
    const out = await askGuide(client, loaded, req, gate(), new QuestionBudget(1));
    expect(create).toHaveBeenCalledTimes(2);
    expect(out.answer).toMatchObject({ origin: "local", webUnavailable: true });
  });

  it("8. nessuna chiamata con nuovi tentativi automatici dell'SDK", async () => {
    const { client, create } = fakeClient(localReply("not_in_knowledge", "Non lo so."), webReply("pause_turn"), webReply("end_turn"));
    await askGuide(client, loaded, req, gate(), new QuestionBudget(5));
    expect(create).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) expect(options(create, i).maxRetries).toBe(0);
  });

  it("9. il modello di ripiego si prezza con il suo listino; un modello sconosciuto è segnalato, non gratis", async () => {
    const iterations = [
      { type: "message", model: "claude-opus-5-5", input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ];
    const a = fakeClient(localReply("answered", "Dalla base.", [ref], { input: 2000, output: 100, iterations }, "claude-opus-4-8"));
    const out = await askGuide(a.client, loaded, req, gate(), new QuestionBudget(1));
    expect(out.costQuality).toBe("measured");
    // 1000 × 4 (Opus 5.5, ha declinato) + 1000 × 5 + 100 × 25 (Opus 4.8)
    expect(out.costUsd).toBeCloseTo(0.004 + 0.005 + 0.0025, 6);
    expect(out.answer.meter?.models).toEqual(["claude-opus-5-5", "claude-opus-4-8"]);

    const b = fakeClient(localReply("answered", "Dalla base.", [ref], {}, "claude-futuro-9"));
    const unknown = await askGuide(b.client, loaded, req, gate(), new QuestionBudget(1));
    expect(unknown.costQuality).toBe("unknown");
    expect(unknown.answer.meter?.costQuality).toBe("unknown");
    expect(unknown.costUsd).toBeCloseTo((1000 * CONSERVATIVE_RATES.input + 100 * CONSERVATIVE_RATES.output) / 1e6, 6);
  });

  it("10. un tempo scaduto non vale zero: si conta il caso peggiore, marcato come stima", async () => {
    const { client } = fakeClient(new Anthropic.APIConnectionTimeoutError());
    const budget = new QuestionBudget(1);
    await expect(askGuide(client, loaded, req, gate(), budget)).rejects.toThrow();
    expect(budget.calls).toHaveLength(1);
    expect(budget.calls[0]).toMatchObject({ kind: "local", outcome: "error", quality: "estimated", usage: null });
    expect(budget.spentUsd).toBeGreaterThan(0);
    expect(budget.quality).toBe("estimated");
  });

  it("10b. un rifiuto HTTP 4xx dell'API (richiesta non eseguita) non consuma", async () => {
    const { client } = fakeClient(new Anthropic.APIError(400, { error: { message: "credito esaurito" } }, "credito esaurito", new Headers()));
    const budget = new QuestionBudget(1);
    await expect(askGuide(client, loaded, req, gate(), budget)).rejects.toThrow();
    expect(budget.calls[0]).toMatchObject({ outcome: "error", usd: 0, quality: "measured" });
  });

  it("13. auto e deep: stesse regole quando il budget non basta per la ricerca", async () => {
    // Abbastanza per la risposta locale, non per la ricerca (né in auto dopo la locale, né in deep con la riserva).
    const limit = (localInputTokens() * 5 + LOCAL_MAX_TOKENS * 20) / 1e6 + 0.01;
    for (const depth of ["auto", "deep"] as const) {
      const { client, create } = fakeClient(localReply("not_in_knowledge", "Non lo so."));
      const out = await askGuide(client, loaded, { ...req, depth }, gate(), new QuestionBudget(limit));
      expect(create, depth).toHaveBeenCalledTimes(1);
      expect(params(create, 0).tools, depth).toBeUndefined();
      expect(out.answer.webUnavailable, depth).toBe(true);
      expect(out.budget.stop, depth).toMatch(/ricerca, giro 1, non avviata/);
      expect(out.costUsd, depth).toBeLessThanOrEqual(limit);
    }
  });

  it("13b. deep con budget sufficiente: la ricerca lascia da parte la risposta locale minima", async () => {
    // Abbastanza per la ricerca piena da sola, non insieme alla riserva.
    const LIMIT = 0.35;
    const deep = { ...req, depth: "deep" as const };
    const { client, create } = fakeClient(webReply("end_turn"));
    const out = await askGuide(client, loaded, deep, gate(), new QuestionBudget(LIMIT));
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.answer.origin).toBe("web");
    const reserve = new QuestionBudget(LIMIT).plan({ model: "claude-opus-5-5", inputTokens: localInputTokens(deep), maxTokens: LOCAL_MIN_TOKENS, minTokens: LOCAL_MIN_TOKENS });
    const webInput = estimateInputTokens(WEB_SYSTEM_PROMPT, PERSONA_PROMPT, loaded.knowledge, buildQuestionMessage(loaded.content, deep) + "\n" + buildWebAddendum(null, deep));
    const plan = (keepUsd: number) =>
      new QuestionBudget(LIMIT).plan({ model: "claude-opus-5-5", inputTokens: webInput, maxTokens: WEB_MAX_TOKENS, minTokens: WEB_MIN_TOKENS, searches: 3, minSearches: 1, keepUsd });
    const kept = plan(reserve.worstUsd);
    const all = plan(0);
    expect(reserve.ok && kept.ok && all.ok).toBe(true);
    if (!kept.ok || !all.ok) return;
    expect(params(create, 0).max_tokens).toBe(kept.maxTokens);
    expect(params(create, 0).tools?.[0]?.max_uses).toBe(kept.searches);
    // Senza la riserva la ricerca avrebbe avuto più spazio.
    expect(kept.searches < all.searches || kept.maxTokens < all.maxTokens).toBe(true);
  });
});

// ------------------------------------------------------------------ statistiche delle prove

describe("statistiche delle prove", () => {
  it("percentili sul rango più vicino, con avviso sotto i 10 campioni", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([3, 1, 2], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(stats([0.01, 0.02]).enough).toBe(false);
    expect(stats(Array.from({ length: 10 }, (_, i) => i)).enough).toBe(true);
  });
  it("la valutazione alla cieca si scioglie con la chiave", () => {
    const key = blindKey(["q1", "q2"], () => 0.9);
    expect(key.q1).toEqual({ X: "b", Y: "a" });
    const good = { ...emptyScore(), corretta: 2, completezza: 2, pertinenza: 2, fonti: 2, fuorviante: false };
    const bad = { ...emptyScore(), corretta: 0, completezza: 1, pertinenza: 2, fonti: 0, fuorviante: true };
    const agg = aggregateScores(key, { q1: { X: good, Y: bad }, q2: { X: good, Y: bad } });
    expect(agg.b).toMatchObject({ valutate: 2, corrette: 1, fuorvianti: 0 });
    expect(agg.a).toMatchObject({ valutate: 2, corrette: 0, fuorvianti: 2 });
  });
});
