import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { buildBundle, type BundleContent } from "@guide/bundle";
import { loadPacks } from "@guide/territory-pack";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { askClock, askRequestSchema, buildKnowledge, type AskRequest } from "../lib/ask.ts";
import { QuestionBudget } from "../lib/ask-cost.ts";
import { askGuide, type Loaded, type WebGate } from "../lib/ask-server.ts";
import { webConfig } from "../lib/ask-web.ts";
import { AnthropicAdapter, OpenAICompatibleAdapter, type AskModels, type ModelRequest } from "../lib/model.ts";

/**
 * Fase B (fornitori alternativi, server locale senza chiave) e fase F1 (data e ora sul posto, dati pratici citabili,
 * prudenza sullo stato di oggi) insieme: le regole della F1 valgono con qualunque fornitore, e i parametri della B
 * (tempo massimo, consumi mancanti) restano quelli di prima. Nessuna chiamata vera: fornitori simulati.
 */
const here = dirname(fileURLToPath(import.meta.url));
let loaded: Loaded;
let req: AskRequest;
let valid: string;
let expired: string;

// 27 ottobre 2026, 14:35 a Roma.
const clock = askClock(Date.UTC(2026, 9, 27, 13, 35));
const json = (o: unknown) => JSON.stringify(o);

beforeAll(() => {
  const { packs } = loadPacks(resolve(here, "../../../territories/_synthetic"));
  const dest = [...packs.values()].find((p) => p.manifest.kind === "destination")!;
  const content: BundleContent = buildBundle(packs, { destination: dest.manifest.id, locale: "it", allowFictional: true }).content;
  const place = content.places[0]!;
  place.practical = [
    { kind: "opening_hours", text: "Aperto tutti i giorni dalle 9 alle 18.", checkedAt: "2026-10-01", recheckAfterDays: 60, source: content.sources[0]!.ref },
    { kind: "access", text: "Il sentiero del belvedere è chiuso per lavori.", checkedAt: "2026-06-01", recheckAfterDays: 90 },
  ];
  valid = `info:${place.ref}#1`;
  expired = `info:${place.ref}#2`;
  loaded = { content, knowledge: buildKnowledge(content), kbHash: "kb-test" };
  req = askRequestSchema.parse({ destination: content.destination, locale: "it", question: "Il sentiero è aperto oggi?", selectedPlace: place.ref });
});

// ------------------------------------------------------------------ server locale tipo Ollama (fase B)

/** Server compatibile OpenAI senza consumi riportati, come spesso un server locale. */
function ollama(answer: object) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
    new Response(json({ model: "modello-locale", choices: [{ finish_reason: "stop", message: { content: json(answer), refusal: null } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const ai: AskModels = { local: new OpenAICompatibleAdapter("http://localhost:11434/v1", null, "modello-locale", fetch, "json_object"), web: null };
  const body = () => JSON.parse(String(fetch.mock.calls[0]![1].body)) as { messages: { role: string; content: string }[] };
  return { ai, fetch, body };
}

describe("server locale senza chiave (fase B) con il contesto della F1", () => {
  it("riceve data e ora sul posto, dati pratici e regola di prudenza; nessuna intestazione di autenticazione", async () => {
    const { ai, fetch, body } = ollama({ status: "answered", answer: "È aperto tutti i giorni dalle 9 alle 18.", citations: [valid] });
    const out = await askGuide(ai, loaded, req, null, new QuestionBudget(1), clock);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1].headers as Record<string, string>).not.toHaveProperty("authorization");
    const [system, user] = body().messages;
    expect(system!.content).toContain("il bel tempo non dimostra che un sentiero sia aperto");
    expect(system!.content).toContain(`${valid} |`);
    expect(system!.content).toContain("FORMATO DELLA RISPOSTA");
    expect(user!.content).toContain("Oggi sul posto: martedì 27 ottobre 2026, ore 14:35 (fuso Europe/Rome)");
    expect(user!.content).toContain(`Informazioni pratiche scadute a oggi (non dirle come attuali: vanno ricontrollate alla fonte): ${expired}`);
    expect(out.answer).toMatchObject({ status: "answered", origin: "local", citations: [valid] });
    // Consumi non riportati: caso peggiore stimato, mai zero (fase B).
    expect(out.costUsd).toBeGreaterThan(0);
    expect(out.costQuality).toBe("unknown");
  });

  it("«è aperto» senza informazione pratica valida è scartato, senza nuovi tentativi", async () => {
    const { ai, fetch } = ollama({ status: "answered", answer: "C'è il sole, il sentiero è aperto.", citations: [] });
    const out = await askGuide(ai, loaded, req, null, new QuestionBudget(1), clock);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out.answer.status).toBe("rejected");
  });

  it("un'informazione pratica scaduta non basta", async () => {
    const { ai } = ollama({ status: "answered", answer: "Il sentiero del belvedere è chiuso per lavori.", citations: [expired] });
    const out = await askGuide(ai, loaded, req, null, new QuestionBudget(1), clock);
    expect(out.rejected).toBe("stato di oggi dichiarato senza un'informazione pratica valida");
  });

  it("una conferma falsa nella conversazione precedente non viene ripetuta", async () => {
    const { ai } = ollama({ status: "answered", answer: "Come ti dicevo, il sentiero è aperto.", citations: [] });
    const withHistory = { ...req, history: [{ question: "È aperto?", answer: "Sì, il sentiero è aperto." }] };
    const out = await askGuide(ai, loaded, withHistory, null, new QuestionBudget(1), clock);
    expect(out.answer.status).toBe("rejected");
  });

  it("risposta scartata: il testo originale resta solo per la valutazione, il visitatore riceve il ripiego", async () => {
    const { ai } = ollama({ status: "answered", answer: "C'è il sole, il sentiero è aperto.", citations: ["it.test:luogo-inventato"] });
    const out = await askGuide(ai, loaded, req, null, new QuestionBudget(1), clock);
    expect(out.answer.status).toBe("rejected");
    expect(out.answer.answer).not.toContain("il sentiero è aperto");
    expect(JSON.parse(out.rejectedText!)).toMatchObject({ answer: "C'è il sole, il sentiero è aperto.", citations: ["it.test:luogo-inventato"] });
    // Una risposta accettata non porta testo scartato.
    const ok = await askGuide(ollama({ status: "not_in_knowledge", answer: "Non lo so.", citations: [] }).ai, loaded, req, null, new QuestionBudget(1), clock);
    expect(ok.rejectedText).toBeUndefined();
  });

  it("dichiarare l'incertezza è ammesso", async () => {
    const { ai } = ollama({ status: "not_in_knowledge", answer: "Non posso verificare se oggi il sentiero sia aperto: controlla sul sito del Parco.", citations: [] });
    const out = await askGuide(ai, loaded, req, null, new QuestionBudget(1), clock);
    expect(out.answer.status).toBe("not_in_knowledge");
  });

  it("«Approfondisci» senza Anthropic: risposta dalla sola base, con le stesse regole", async () => {
    const { ai } = ollama({ status: "answered", answer: "Il sentiero è aperto.", citations: [] });
    const gate: WebGate = { config: webConfig({}), supported: true, permitted: () => true };
    const out = await askGuide(ai, loaded, { ...req, depth: "deep" }, gate, new QuestionBudget(1), clock);
    expect(out.answer.status).toBe("rejected");
    expect(out.web).toBeUndefined();
  });

  it("ASK_TIMEOUT_MS e la data sul posto arrivano entrambi al modello", async () => {
    const seen: { timeoutMs: number; user: string }[] = [];
    const local = {
      provider: "finto",
      model: "modello-locale",
      generate: async (r: ModelRequest) => {
        seen.push({ timeoutMs: r.timeoutMs, user: r.user });
        return { text: json({ status: "off_topic", answer: "Parliamo della visita.", citations: [] }), stop: "end" as const, usage: null, model: "modello-locale" };
      },
    };
    await askGuide({ local, web: null, localTimeoutMs: 40_000 }, loaded, req, null, new QuestionBudget(1), clock);
    await askGuide({ local, web: null }, loaded, req, null, new QuestionBudget(1), clock);
    expect(seen.map((s) => s.timeoutMs)).toEqual([40_000, 25_000]);
    for (const s of seen) expect(s.user).toContain("martedì 27 ottobre 2026, ore 14:35");
  });
});

// ------------------------------------------------------------------ Anthropic (fornitore di produzione)

const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null };
function fakeAnthropic(...replies: object[]) {
  const create = vi.fn(async (_params: unknown, _options?: unknown) => {
    const next = replies.shift();
    if (!next) throw new Error("nessuna risposta prevista");
    return next;
  });
  const client = { beta: { messages: { create } } } as unknown as Anthropic;
  return { ai: { local: new AnthropicAdapter(client), web: client } satisfies AskModels, create };
}
const localReply = (o: object) => ({ content: [{ type: "text", text: json(o) }], stop_reason: "end_turn", model: "claude-opus-5-5", usage });

describe("Anthropic con il contesto della F1", () => {
  it("stesse regole: «è aperto» scartato, informazione valida accettata con costo misurato", async () => {
    const { ai, create } = fakeAnthropic(
      localReply({ status: "answered", answer: "Il sentiero è aperto.", citations: [] }),
      localReply({ status: "answered", answer: "È aperto tutti i giorni dalle 9 alle 18.", citations: [valid] }),
    );
    const bad = await askGuide(ai, loaded, req, null, new QuestionBudget(1), clock);
    expect(bad.answer.status).toBe("rejected");
    const good = await askGuide(ai, loaded, req, null, new QuestionBudget(1), clock);
    expect(good.answer).toMatchObject({ status: "answered", citations: [valid] });
    expect(good.costQuality).toBe("measured");
    const params = create.mock.calls[0]![0] as { messages: { content: string }[] };
    expect(JSON.stringify(params.messages)).toContain("Oggi sul posto: martedì 27 ottobre 2026");
  });

  it("«Approfondisci» con la ricerca: il messaggio porta la data, i dati pratici si citano", async () => {
    const webReply = {
      content: [
        { type: "text", text: "Secondo la pagina del Comune gli orari valgono fino a novembre.", citations: [{ type: "web_search_result_location", url: "https://www.comune.esempio.it/orari", title: "Orari", cited_text: "orari", encrypted_index: "x" }] },
        { type: "text", text: ` La guida riporta gli orari [[${valid}]].` },
      ],
      stop_reason: "end_turn",
      model: "claude-opus-5-5",
      usage: { ...usage, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } },
    };
    const { ai, create } = fakeAnthropic(webReply);
    const gate: WebGate = { config: webConfig({}), supported: true, permitted: () => true };
    const out = await askGuide(ai, loaded, { ...req, depth: "deep" }, gate, new QuestionBudget(10), clock);
    const params = create.mock.calls[0]![0] as { system: { text: string }[]; messages: { content: string }[] };
    expect(params.messages[0]!.content).toContain("Oggi sul posto: martedì 27 ottobre 2026");
    expect(params.system.map((b) => b.text).join("\n")).toContain("il bel tempo non dimostra che un sentiero sia aperto");
    expect(out.answer).toMatchObject({ origin: "web", citations: [valid] });
  });
});
