import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundle } from "@guide/bundle";
import { loadPacks } from "@guide/territory-pack";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildKnowledge } from "../lib/ask.ts";
import type { Loaded } from "../lib/ask-server.ts";

/**
 * La route /api/guide/ask con l'SDK Anthropic sostituito da un finto: nessuna chiamata reale.
 * Verifica configurazione del budget, client senza nuovi tentativi e cache delle risposte.
 */
const h = vi.hoisted(() => ({
  create: vi.fn(),
  retrieve: vi.fn(async () => ({ capabilities: { server_tools: { web_search: { supported: true } } } })),
  clientOptions: [] as unknown[],
  loaded: null as unknown,
  rpc: vi.fn(),
  createClient: vi.fn(),
}));
// Supabase finto per il registro delle domande senza risposta: nessuna rete.
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => {
    h.createClient(...args);
    return { rpc: (...a: unknown[]) => ({ abortSignal: () => h.rpc(...a) }) };
  },
}));

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class FakeAnthropic extends mod.default {
    constructor(opts?: ConstructorParameters<typeof mod.default>[0]) {
      super({ ...opts, apiKey: "chiave-finta" });
      h.clientOptions.push(opts);
      Object.assign(this, { beta: { messages: { create: h.create } }, models: { retrieve: h.retrieve } });
    }
  }
  return { ...mod, default: FakeAnthropic };
});
vi.mock("../lib/ask-server.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ask-server.ts")>()),
  loadKnowledge: vi.fn(async () => h.loaded),
  bundleVersions: vi.fn(async () => []),
}));

const here = dirname(fileURLToPath(import.meta.url));
let destination = "";
let ref = "";
let placeRef = "";
beforeAll(() => {
  const { packs } = loadPacks(resolve(here, "../../../territories/_synthetic"));
  const dest = [...packs.values()].find((p) => p.manifest.kind === "destination")!;
  const content = buildBundle(packs, { destination: dest.manifest.id, locale: "it", allowFictional: true }).content;
  h.loaded = { content, knowledge: buildKnowledge(content), kbHash: "kb-test" } satisfies Loaded;
  destination = content.destination;
  ref = content.assertions[0]!.ref;
  placeRef = content.places[0]!.ref;
});

beforeEach(() => {
  h.create.mockReset();
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: "created", error: null });
  h.createClient.mockReset();
  h.clientOptions.length = 0;
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Carica la route da capo con queste variabili (la configurazione si legge al caricamento). */
async function route(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  return import("../app/api/guide/ask/route.ts");
}
const post = (body: object) =>
  new Request("http://localhost/api/guide/ask", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify(body) });
const localReply = () => ({
  content: [{ type: "text", text: JSON.stringify({ status: "answered", answer: "Dalla base.", citations: [ref] }) }],
  stop_reason: "end_turn",
  model: "claude-opus-5-5",
  usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null },
});

describe("route delle domande", () => {
  it("senza ASK_MAX_USD_PER_QUESTION (o con un valore non valido) nessuna chiamata e domande spente", async () => {
    for (const value of [undefined, "abc", "-1", "0"]) {
      const r = await route({ ANTHROPIC_API_KEY: "x", ASK_MAX_USD_PER_QUESTION: value });
      const res = await r.POST(post({ destination, locale: "it", question: "Perché fu costruito qui?" }));
      expect(res.status, String(value)).toBe(503);
      expect((await res.json()).status).toBe("unavailable");
      const info = await (await r.GET()).json();
      expect(info).toMatchObject({ available: false, budget: { configured: false } });
    }
    expect(h.create).not.toHaveBeenCalled();
  });

  it("il client Anthropic è creato senza nuovi tentativi automatici", async () => {
    h.create.mockResolvedValueOnce(localReply());
    const r = await route({ ANTHROPIC_API_KEY: "x", ASK_MAX_USD_PER_QUESTION: "0.5" });
    await r.POST(post({ destination, locale: "it", question: "Perché fu costruito qui?" }));
    // La chiave arriva da modelsFromEnv (lib/model.ts); qui conta che non ci siano nuovi tentativi.
    expect(h.clientOptions).toEqual([expect.objectContaining({ maxRetries: 0 })]);
    expect((h.create.mock.calls[0]![1] as { maxRetries: number }).maxRetries).toBe(0);
  });

  it("12. la stessa domanda dalla cache non richiama il modello e costa zero", async () => {
    h.create.mockResolvedValueOnce(localReply());
    const r = await route({ ANTHROPIC_API_KEY: "x", ASK_MAX_USD_PER_QUESTION: "0.5" });
    const body = { destination, locale: "it", question: "Perché fu costruito qui?" };
    const first = await (await r.POST(post(body))).json();
    expect(first).toMatchObject({ status: "answered", meter: { calls: 1, costQuality: "measured" } });
    const second = await (await r.POST(post({ ...body, question: "perché fu costruito QUI" }))).json();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ status: "answered", cached: true, meter: { calls: 0, costUsd: 0 } });
  });

  it("i log della domanda riportano budget, qualità del costo e chiamate, senza la chiave", async () => {
    h.create.mockResolvedValueOnce(localReply());
    const r = await route({ ANTHROPIC_API_KEY: "sk-segreta", ASK_MAX_USD_PER_QUESTION: "0.5" });
    await r.POST(post({ destination, locale: "it", question: "Perché fu costruito qui?" }));
    const logs = (console.info as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]!);
    const ask = JSON.parse(logs.find((l) => l.includes('"event":"ask"'))!);
    expect(ask).toMatchObject({ costQuality: "measured", budget: { limitUsd: 0.5, calls: 1 }, modelCalls: [{ kind: "local", outcome: "ok", quality: "measured" }] });
    expect(logs.join("\n")).not.toContain("sk-segreta");
  });

  it("un errore del modello finisce nei log con il costo stimato, non zero", async () => {
    h.create.mockRejectedValueOnce(new Error("socket hang up"));
    const r = await route({ ANTHROPIC_API_KEY: "x", ASK_MAX_USD_PER_QUESTION: "0.5" });
    const res = await r.POST(post({ destination, locale: "it", question: "Perché fu costruito qui?" }));
    expect(res.status).toBe(502);
    const errors = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]!);
    const logged = JSON.parse(errors.find((l) => l.includes('"event":"ask_error"'))!);
    expect(logged.budget.quality).toBe("estimated");
    expect(logged.budget.spentUsd).toBeGreaterThan(0);
  });
});

describe("ricerca online solo su richiesta", () => {
  const env = { ANTHROPIC_API_KEY: "x", ASK_MAX_USD_PER_QUESTION: "0.5" };
  const notFound = () => ({
    ...localReply(),
    content: [{ type: "text", text: JSON.stringify({ status: "not_in_knowledge", answer: "Non ho questa informazione.", citations: [] }) }],
  });
  const tools = (i: number) => (h.create.mock.calls[i]![0] as { tools?: unknown[] }).tools;

  it("una domanda senza risposta fa una sola chiamata, senza ricerca, e ripetuta arriva dalla cache a costo zero", async () => {
    h.create.mockResolvedValueOnce(notFound());
    const r = await route(env);
    const body = { destination, locale: "it", question: "Ci sono spiagge?" };
    const first = await (await r.POST(post(body))).json();
    expect(first).toMatchObject({ status: "not_in_knowledge", meter: { calls: 1, webSearches: 0 } });
    expect(first.origin ?? "local").toBe("local");
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(tools(0)).toBeUndefined();
    const second = await (await r.POST(post(body))).json();
    expect(second).toMatchObject({ status: "not_in_knowledge", cached: true, meter: { calls: 0, costUsd: 0 } });
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it("con «Approfondisci» la ricerca parte", async () => {
    h.create.mockRejectedValue(new Error("fine della prova"));
    const r = await route(env);
    await r.POST(post({ destination, locale: "it", question: "Ci sono spiagge?", depth: "deep" }));
    expect(h.create).toHaveBeenCalled();
    expect(JSON.stringify(tools(0))).toContain("web_search");
  });

  it("con ASK_WEB_AUTO=1 la ricerca riparte da sola quando la base non basta", async () => {
    h.create.mockResolvedValueOnce(notFound()).mockRejectedValue(new Error("fine della prova"));
    const r = await route({ ...env, ASK_WEB_AUTO: "1" });
    await r.POST(post({ destination, locale: "it", question: "Ci sono spiagge?" }));
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(tools(1))).toContain("web_search");
  });
});

describe("registro delle domande senza risposta", () => {
  const SERVICE_KEY = "chiave-di-servizio-segreta-0123456789";
  const gapsEnv = {
    ANTHROPIC_API_KEY: "x",
    ASK_MAX_USD_PER_QUESTION: "0.5",
    ASK_WEB_ENABLED: "0",
    QUESTION_GAPS_ENABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: "https://progetto.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  };
  const reply = (status: string, citations: string[] = []) => ({
    ...localReply(),
    content: [{ type: "text", text: JSON.stringify({ status, answer: status === "answered" ? "Dalla base." : "Non ho questa informazione.", citations }) }],
  });
  const allLogs = () =>
    [console.info, console.warn, console.error].flatMap((f) => (f as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))).join("\n");
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("registra la lacuna dopo la risposta, senza chiamate in più al modello e senza cambiare la risposta", async () => {
    h.create.mockResolvedValueOnce(reply("not_in_knowledge"));
    const r = await route(gapsEnv);
    const res = await r.POST(post({ destination, locale: "it", question: "A che ora apre? Scrivetemi a mario.rossi@example.it" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("not_in_knowledge");
    await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    const [fn, args] = h.rpc.mock.calls[0]!;
    expect(fn).toBe("gap_record");
    expect(args).toMatchObject({ p_pack: destination, p_locale: "it", p_kind: "not_in_knowledge", p_question: "A che ora apre? Scrivetemi a [email]" });
    expect(JSON.stringify(args)).not.toContain("203.0.113.7");
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(allLogs()).not.toContain(SERVICE_KEY);
  });

  it("nella riga solo i campi previsti: niente cronologia, già raccontato, vicini, posizione o luoghi inventati", async () => {
    h.create.mockResolvedValueOnce(reply("not_in_knowledge"));
    const r = await route(gapsEnv);
    await r.POST(post({
      destination, locale: "it", question: "A che ora apre?",
      currentPlace: "Mario Rossi via Roma 3", selectedPlace: placeRef,
      position: { lon: 9.81234, lat: 44.05678, accuracyM: 8 },
      nearby: [placeRef], told: [ref],
      history: [{ question: "Mi chiamo Mario", answer: "Risposta precedente riservata" }],
    }));
    await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    const args = h.rpc.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(
      ["p_kb_hash", "p_key", "p_kind", "p_locale", "p_pack", "p_place", "p_prompt", "p_question", "p_reason", "p_selected", "p_web_sources"].sort(),
    );
    expect(args).toMatchObject({ p_place: null, p_selected: placeRef, p_question: "A che ora apre?" });
    const text = JSON.stringify(args);
    for (const leak of ["Mario", "Roma", "riservata", "9.81", "44.05", "203.0.113.7", ref]) expect(text, leak).not.toContain(leak);
  });

  it("le risposte complete, le emergenze e il registro spento non scrivono nulla", async () => {
    h.create.mockResolvedValueOnce(reply("answered", [ref]));
    let r = await route(gapsEnv);
    await r.POST(post({ destination, locale: "it", question: "Chi costruì il porto?" }));
    await r.POST(post({ destination, locale: "it", question: "Aiuto, mi sento male, chiamate un'ambulanza" }));
    await settle();
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.create).toHaveBeenCalledTimes(1);

    h.create.mockResolvedValueOnce(reply("not_in_knowledge"));
    r = await route({ ...gapsEnv, QUESTION_GAPS_ENABLED: undefined });
    await r.POST(post({ destination, locale: "it", question: "A che ora apre?" }));
    await settle();
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("un errore del database non interrompe né cambia la risposta, e i log restano senza chiave né testo", async () => {
    h.create.mockResolvedValueOnce(reply("not_in_knowledge"));
    h.rpc.mockReset();
    h.rpc.mockRejectedValue(new Error(`connessione rifiutata ${SERVICE_KEY}`));
    const r = await route(gapsEnv);
    const res = await r.POST(post({ destination, locale: "it", question: "A che ora apre il museo?" }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("not_in_knowledge");
    await vi.waitFor(() => expect(allLogs()).toContain("question_gap_failed"));
    expect(allLogs()).not.toContain(SERVICE_KEY);
    // Il log dell'errore del registro non ripete la domanda (quello di knowledge_gap la riporta già mascherata).
    expect(allLogs().split("\n").filter((l) => l.includes("question_gap")).join("\n")).not.toContain("museo");
  });

  it("una risposta parziale dalla cache si conta di nuovo senza richiamare il modello", async () => {
    h.create.mockResolvedValueOnce(reply("partial", [ref]));
    const r = await route(gapsEnv);
    const body = { destination, locale: "it", question: "Chi costruì il porto e quando?" };
    const first = await (await r.POST(post(body))).json();
    expect(first.status).toBe("partial");
    const second = await (await r.POST(post(body))).json();
    expect(second).toMatchObject({ status: "partial", cached: true });
    await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(2));
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.rpc.mock.calls.map((c) => (c[1] as { p_kind: string }).p_kind)).toEqual(["partial", "partial"]);
  });

  it("al massimo 5 righe ogni 10 minuti per indirizzo", async () => {
    for (let i = 0; i < 7; i++) h.create.mockResolvedValueOnce(reply("not_in_knowledge"));
    const r = await route(gapsEnv);
    for (let i = 0; i < 7; i++) await r.POST(post({ destination, locale: "it", question: `Domanda senza risposta numero ${i}?` }));
    await settle();
    expect(h.create).toHaveBeenCalledTimes(7);
    expect(h.rpc).toHaveBeenCalledTimes(5);
  });
});

describe("route delle domande: tempo massimo e fornitori alternativi (fase B)", () => {
  const body = { destination: "", locale: "it", question: "Perché fu costruito qui?" };

  it("per default la risposta locale ha 25 s; con ASK_TIMEOUT_MS il tempo configurato", async () => {
    h.create.mockResolvedValueOnce(localReply());
    let r = await route({ ANTHROPIC_API_KEY: "x", ASK_MAX_USD_PER_QUESTION: "0.5" });
    await r.POST(post({ ...body, destination }));
    expect((h.create.mock.calls[0]![1] as { timeout: number }).timeout).toBe(25_000);
    h.create.mockResolvedValueOnce(localReply());
    r = await route({ ANTHROPIC_API_KEY: "x", ASK_MAX_USD_PER_QUESTION: "0.5", ASK_TIMEOUT_MS: "40000" });
    await r.POST(post({ ...body, destination, question: "Chi lo costruì?" }));
    expect((h.create.mock.calls[1]![1] as { timeout: number }).timeout).toBe(40_000);
  });

  it("un ASK_TIMEOUT_MS non valido spegne le domande: nessuna chiamata, 503", async () => {
    const r = await route({ ANTHROPIC_API_KEY: "x", ASK_MAX_USD_PER_QUESTION: "0.5", ASK_TIMEOUT_MS: "999999" });
    const res = await r.POST(post({ ...body, destination }));
    expect(res.status).toBe(503);
    expect((await r.GET().then((g) => g.json())).available).toBe(false);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("tempo scaduto: 504, stessa risposta per il visitatore, tipo «timeout» nei log, costo contato", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    h.create.mockRejectedValueOnce(new Anthropic.APIConnectionTimeoutError());
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await route({ ANTHROPIC_API_KEY: "x", ASK_MAX_USD_PER_QUESTION: "0.5" });
    const res = await r.POST(post({ ...body, destination }));
    expect(res.status).toBe(504);
    expect((await res.json()).status).toBe("unavailable");
    const logged = errors.mock.calls.map((c) => JSON.parse(String(c[0]))).find((e) => e.event === "ask_error");
    expect(logged).toMatchObject({ kind: "timeout", provider: "anthropic" });
    // Una chiamata scaduta può essere già stata pagata: il suo caso peggiore entra nel conto.
    expect(logged.budget.spentUsd).toBeGreaterThan(0);
  });

  it("fornitore compatibile OpenAI locale: la route lo usa senza chiamare Anthropic e senza ricerca web", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input)).toBe("http://localhost:11434/v1/chat/completions");
      return new Response(JSON.stringify({ model: "modello-locale", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ status: "answered", answer: "Dalla base.", citations: [ref] }) } }] }), { status: 200 });
    });
    const r = await route({ ASK_PROVIDER: "openai-compatible", ASK_BASE_URL: "http://localhost:11434/v1", ASK_MODEL: "modello-locale", ASK_MAX_USD_PER_QUESTION: "0.5", ANTHROPIC_API_KEY: "" });
    const info = await (await r.GET()).json();
    expect(info).toMatchObject({ available: true, provider: "openai-compatible", model: "modello-locale", web: { enabled: false } });
    const res = await (await r.POST(post({ ...body, destination }))).json();
    expect(res).toMatchObject({ status: "answered", origin: "local", meter: { calls: 1, costQuality: "unknown" } });
    // Il servizio non ha riportato i consumi: il costo è il caso peggiore stimato, non zero.
    expect(res.meter.costUsd).toBeGreaterThan(0);
    expect(h.create).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("risposta scartata: il visitatore riceve il ripiego, e il testo del modello non va né nella risposta né nei log", async () => {
    const secret = "TESTO-SCARTATO-DAL-CONTROLLO";
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ model: "modello-locale", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ status: "answered", answer: `${secret} nel 1312.`, citations: ["x:inventata"] }) } }] }), { status: 200 }),
    );
    const r = await route({ ASK_PROVIDER: "openai-compatible", ASK_BASE_URL: "http://localhost:11434/v1", ASK_MODEL: "modello-locale", ASK_MAX_USD_PER_QUESTION: "0.5", ANTHROPIC_API_KEY: "" });
    const raw = await (await r.POST(post({ ...body, destination }))).text();
    expect(JSON.parse(raw)).toMatchObject({ status: "rejected" });
    expect(raw).not.toContain(secret);
    const logs = [console.info, console.error, console.warn].flatMap((f) => vi.mocked(f).mock.calls.flat()).map(String).join("\n");
    expect(logs).toContain("citazioni inesistenti");
    expect(logs).not.toContain(secret);
  });

  it("errore HTTP del fornitore: nei log il motivo scritto dal servizio, accorciato e senza la chiave", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ error: `modello sovraccarico, chiave-del-servizio ${"x".repeat(400)}` }), { status: 500 }),
    );
    const r = await route({ ASK_PROVIDER: "openai-compatible", ASK_BASE_URL: "https://servizio.example/v1", ASK_API_KEY: "chiave-del-servizio", ASK_MODEL: "m", ASK_MAX_USD_PER_QUESTION: "0.5", ANTHROPIC_API_KEY: "" });
    const res = await r.POST(post({ ...body, destination }));
    expect(res.status).toBe(502);
    const logs = vi.mocked(console.error).mock.calls.flat().map(String).join("\n");
    expect(logs).toContain("HTTP 500: modello sovraccarico");
    expect(logs).not.toContain("chiave-del-servizio");
    expect(logs).toContain("[chiave]");
  });
});
