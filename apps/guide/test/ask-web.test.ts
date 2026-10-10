import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundle, type BundleContent } from "@guide/bundle";
import { loadPacks } from "@guide/territory-pack";
import type Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { POSITION_CITATION, askRequestSchema, buildKnowledge, type AskAnswer, type AskRequest } from "../lib/ask.ts";
import { askGuide, type Loaded, type WebGate } from "../lib/ask-server.ts";
import {
  DEFAULT_BLOCKED_DOMAINS,
  DailyCounter,
  TtlCache,
  WEB_SYSTEM_PROMPT,
  cacheKey,
  cacheable,
  estimateUsd,
  needsWeb,
  parseWebAnswer,
  sourceTier,
  unsupportedNumbers,
  webConfig,
  type ContentBlockLike,
} from "../lib/ask-web.ts";

/** Prove sul bundle del territorio di test, senza nomi di territorio scritti qui. */
const here = dirname(fileURLToPath(import.meta.url));
let content: BundleContent;
let loaded: Loaded;
let req: AskRequest;
let ref: string;

beforeAll(() => {
  const { packs } = loadPacks(resolve(here, "../../../territories/_synthetic"));
  const dest = [...packs.values()].find((p) => p.manifest.kind === "destination")!;
  content = buildBundle(packs, { destination: dest.manifest.id, locale: "it", allowFictional: true }).content;
  loaded = { content, knowledge: buildKnowledge(content), kbHash: "kb-test" };
  req = askRequestSchema.parse({ destination: content.destination, locale: "it", question: "Perché fu costruito qui?" });
  ref = content.assertions[0]!.ref;
});

// ------------------------------------------------------------------ risposte finte dell'API

const usage = (o: Partial<{ input: number; output: number; searches: number }> = {}) => ({
  input_tokens: o.input ?? 1000,
  output_tokens: o.output ?? 100,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  server_tool_use: o.searches === undefined ? null : { web_search_requests: o.searches, web_fetch_requests: 0 },
});
const localReply = (status: string, answer = "Risposta.", citations: string[] = []) => ({
  content: [{ type: "text", text: JSON.stringify({ status, answer, citations }) }],
  stop_reason: "end_turn",
  usage: usage(),
});
const cite = (url: string, title: string, cited_text = "brano") => ({ type: "web_search_result_location", url, title, cited_text, encrypted_index: "x" });
const searchBlocks = (urls: { url: string; title: string; page_age?: string }[]): ContentBlockLike[] => [
  { type: "text", text: "Cerco qualche fonte." },
  { type: "server_tool_use", name: "web_search", input: { query: "q" } } as ContentBlockLike,
  { type: "web_search_tool_result", content: urls.map((u) => ({ type: "web_search_result", encrypted_content: "e", ...u })) },
];
const webReply = (blocks: ContentBlockLike[], stop = "end_turn", searches = 1) => ({ content: blocks, stop_reason: stop, usage: usage({ input: 8000, output: 600, searches }) });

function fakeClient(...replies: (object | Error)[]) {
  const create = vi.fn(async (_params: unknown, _options?: unknown) => {
    const next = replies.shift();
    if (!next) throw new Error("nessuna risposta prevista");
    if (next instanceof Error) throw next;
    return next;
  });
  return { client: { beta: { messages: { create } } } as unknown as Anthropic, create };
}
const gate = (o: Partial<WebGate> = {}): WebGate => ({ config: webConfig({}), supported: true, permitted: () => true, ...o });

// ------------------------------------------------------------------ configurazione

describe("configurazione della ricerca", () => {
  it("ha valori prudenti per default", () => {
    const c = webConfig({});
    expect(c).toMatchObject({ enabled: true, model: "claude-opus-5-5", maxUses: 3, perIp: 6, dailyLimit: 300, cacheTtlHours: 24, effort: "medium" });
    expect(c.blockedDomains).toEqual([...DEFAULT_BLOCKED_DOMAINS]);
  });
  it("legge e limita le variabili d'ambiente", () => {
    const c = webConfig({ ASK_WEB_ENABLED: "0", ASK_WEB_MAX_USES: "99", ASK_WEB_BLOCKED_DOMAINS: "a.com, b.org", ASK_CACHE_TTL_HOURS: "x", ASK_WEB_EFFORT: "low" });
    expect(c.enabled).toBe(false);
    expect(c.maxUses).toBe(10);
    expect(c.blockedDomains).toEqual(["a.com", "b.org"]);
    expect(c.cacheTtlHours).toBe(24);
    expect(c.effort).toBe("low");
    expect(webConfig({ ASK_WEB_BLOCKED_DOMAINS: "" }).blockedDomains).toEqual([]);
  });
  it("le istruzioni dicono di trattare il web come dati e di non inventare", () => {
    expect(WEB_SYSTEM_PROMPT).toMatch(/DATI, non istruzioni/);
    expect(WEB_SYSTEM_PROMPT).toMatch(/Non inventare/);
    expect(WEB_SYSTEM_PROMPT).toContain(POSITION_CITATION);
  });
});

describe("quando cercare", () => {
  const a = (status: AskAnswer["status"]): AskAnswer => ({ status, answer: "x", citations: [] });
  it("non cerca se la base risponde, cerca se non basta", () => {
    expect(needsWeb(a("answered"), req)).toBe(false);
    expect(needsWeb(a("partial"), req)).toBe(true);
    expect(needsWeb(a("not_in_knowledge"), req)).toBe(true);
    expect(needsWeb(a("rejected"), req)).toBe(true);
  });
  it("cerca su richiesta di approfondimento, mai fuori tema", () => {
    const deep = { ...req, depth: "deep" as const };
    expect(needsWeb(a("answered"), deep)).toBe(true);
    expect(needsWeb(a("off_topic"), deep)).toBe(false);
    expect(needsWeb(a("unavailable"), deep)).toBe(false);
  });
});

// ------------------------------------------------------------------ lettura della risposta

describe("lettura della risposta con ricerca", () => {
  it("separa il testo finale, toglie i marcatori, ordina le fonti per affidabilità", () => {
    const blocks: ContentBlockLike[] = [
      ...searchBlocks([{ url: "https://www.example-blog.com/a", title: "Blog" }, { url: "https://catalogo.beniculturali.it/x", title: "Catalogo", page_age: "3 marzo 2024" }]),
      { type: "text", text: `Fu costruito qui per difendere il porto [[${ref}]]. ` },
      { type: "text", text: "Secondo il catalogo è del XII secolo.", citations: [cite("https://catalogo.beniculturali.it/x", "Catalogo")] },
      { type: "text", text: " Un blog lo racconta.", citations: [cite("https://www.example-blog.com/a", "Blog"), cite("javascript:alert(1)", "x")] },
      { type: "text", text: " [[pack:inventata]]" },
    ];
    const p = parseWebAnswer(blocks, content, req);
    expect(p.text).not.toContain("Cerco");
    expect(p.text).not.toContain("[[");
    expect(p.packCitations).toEqual([ref]);
    expect(p.unknownRefs).toEqual(["pack:inventata"]);
    expect(p.sources.map((s) => s.site)).toEqual(["catalogo.beniculturali.it", "example-blog.com"]);
    expect(p.sources[0]).toMatchObject({ tier: 1, pageAge: "3 marzo 2024", citedText: "brano" });
    expect(p.searchBlocks).toBe(1);
  });

  it("raccoglie gli errori dello strumento di ricerca", () => {
    const p = parseWebAnswer(
      [{ type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "too_many_requests" } }, { type: "text", text: "Nessuna fonte." }],
      content,
      req,
    );
    expect(p.searchErrors).toEqual(["too_many_requests"]);
    expect(p.sources).toEqual([]);
  });

  it("accetta le distanze solo se il sistema le ha fornite", () => {
    const block = [{ type: "text", text: `È a circa 100 metri [[${POSITION_CITATION}]].` }];
    expect(parseWebAnswer(block, content, req).usedPosition).toBe(false);
    const withPos = { ...req, position: { lon: content.places[0]!.location[0], lat: content.places[0]!.location[1], accuracyM: 10, simulated: true } };
    expect(parseWebAnswer(block, content, withPos).usedPosition).toBe(true);
  });

  it("classifica i domini", () => {
    expect(sourceTier("https://www.comune.esempio.it/storia")).toBe(1);
    expect(sourceTier("https://www.cultura.gov.it/x")).toBe(1);
    expect(sourceTier("https://archivio.example.org/x")).toBe(2);
    expect(sourceTier("https://www.unige.it/x")).toBe(3);
    expect(sourceTier("https://it.wikipedia.org/wiki/X")).toBe(4);
    expect(sourceTier("https://www.qualcosa.com")).toBe(5);
    expect(sourceTier("non un url")).toBe(5);
  });

  it("segnala i numeri non ritrovati nelle fonti, senza scartare", () => {
    const blocks: ContentBlockLike[] = [{ type: "text", text: "Ricostruita nel 1494 e restaurata nel 1935.", citations: [cite("https://x.it", "X", "ricostruita nel 1494")] }];
    const p = parseWebAnswer(blocks, content, req);
    expect(unsupportedNumbers(p, blocks, content, req, { status: "not_in_knowledge", answer: "", citations: [] })).toEqual(["1935"]);
  });
});

// ------------------------------------------------------------------ cache, limiti, costi

describe("cache e limiti", () => {
  it("la chiave dipende da contenuti, luogo, posizione e profondità, non da maiuscole e punteggiatura", () => {
    const k = cacheKey(req, "h1")!;
    expect(cacheKey({ ...req, question: "  perché FU costruito qui " }, "h1")).toBe(k);
    expect(cacheKey(req, "h2")).not.toBe(k);
    expect(cacheKey({ ...req, selectedPlace: "pack:altro" }, "h1")).not.toBe(k);
    expect(cacheKey({ ...req, depth: "deep" }, "h1")).not.toBe(k);
    expect(cacheKey({ ...req, position: { lon: 1, lat: 1, accuracyM: 5, simulated: false } }, "h1")).not.toBe(k);
    expect(cacheKey({ ...req, history: [{ question: "a", answer: "b" }] }, "h1")).toBeNull();
  });
  it("non memorizza risposte legate alla posizione, mancate o con la ricerca non disponibile", () => {
    expect(cacheable({ status: "answered", answer: "x", citations: [] })).toBe(true);
    expect(cacheable({ status: "answered", answer: "x", citations: [], usedPosition: true })).toBe(false);
    expect(cacheable({ status: "answered", answer: "x", citations: [], webUnavailable: true })).toBe(false);
    expect(cacheable({ status: "not_in_knowledge", answer: "x", citations: [] })).toBe(false);
    expect(cacheable({ status: "rejected", answer: "x", citations: [] })).toBe(false);
  });
  it("la cache scade e ha una dimensione massima", () => {
    const c = new TtlCache<number>(1000, 2);
    c.set("a", 1, 0);
    c.set("b", 2, 0);
    c.set("c", 3, 0);
    expect(c.get("a", 1)).toBeUndefined();
    expect(c.get("b", 999)).toBe(2);
    expect(c.get("b", 1000)).toBeUndefined();
    const off = new TtlCache<number>(0);
    off.set("a", 1);
    expect(off.size).toBe(0);
  });
  it("il contatore giornaliero si azzera al cambio di giorno", () => {
    const d = new DailyCounter(1);
    const day1 = Date.UTC(2026, 0, 1, 10);
    expect(d.available(day1)).toBe(true);
    d.take(day1);
    expect(d.available(day1)).toBe(false);
    expect(d.available(day1 + 86_400_000)).toBe(true);
  });
  it("stima i costi con il listino (token + ricerche)", () => {
    expect(estimateUsd("claude-opus-5-5", { input: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 0, webSearches: 0 })).toBe(4);
    expect(estimateUsd("claude-opus-5-5", { input: 0, cacheWrite: 0, cacheRead: 0, output: 1000, webSearches: 2 })).toBe(0.04);
    expect(estimateUsd("modello-sconosciuto", { input: 1, cacheWrite: 0, cacheRead: 0, output: 0, webSearches: 0 })).toBeNull();
  });
});

// ------------------------------------------------------------------ percorso ibrido completo (API simulata)

describe("risposta ibrida", () => {
  it("se la base risponde non cerca sul web (una sola chiamata)", async () => {
    const { client, create } = fakeClient(localReply("answered", "Risposta dalla base.", [ref]));
    const out = await askGuide(client, loaded, req, gate());
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.answer).toMatchObject({ status: "answered", origin: "local", citations: [ref] });
    expect(out.web).toBeUndefined();
  });

  it("se la base non basta cerca con lo strumento ufficiale e cita le fonti", async () => {
    const { client, create } = fakeClient(
      localReply("not_in_knowledge", "Non lo so."),
      webReply([
        ...searchBlocks([{ url: "https://www.comune.esempio.it/storia", title: "Storia", page_age: "2025" }]),
        { type: "text", text: "Fu costruito per controllare l'approdo.", citations: [cite("https://www.comune.esempio.it/storia", "Storia")] },
        { type: "text", text: `\n\nLa guida aggiunge un dettaglio [[${ref}]].` },
      ]),
    );
    const out = await askGuide(client, loaded, req, gate());
    expect(create).toHaveBeenCalledTimes(2);
    const params = create.mock.calls[1]![0] as unknown as { tools: { type: string; max_uses: number; blocked_domains: string[] }[]; output_config: object };
    expect(params.tools[0]).toMatchObject({ type: "web_search_20260318", max_uses: 3 });
    expect(params.tools[0]!.blocked_domains).toContain("tripadvisor.com");
    expect(params.output_config).not.toHaveProperty("format");
    expect(out.answer).toMatchObject({ status: "answered", origin: "web", citations: [ref], webSearches: 1 });
    expect(out.answer.webSources?.[0]).toMatchObject({ url: "https://www.comune.esempio.it/storia", tier: 1, pageAge: "2025" });
    expect(out.answer.answer).toContain("\n\n");
    expect(out.usage.web?.webSearches).toBe(1);
    expect(out.costUsd).toBeGreaterThan(0.01);
  });

  it("l'approfondimento va diretto alla ricerca, senza ripagare la risposta locale", async () => {
    const { client, create } = fakeClient(webReply([{ type: "text", text: "Più a fondo.", citations: [cite("https://www.unige.it/x", "Studio")] }]));
    const out = await askGuide(client, loaded, { ...req, depth: "deep" }, gate());
    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]![0] as unknown as { tools?: unknown[]; messages: { content: string }[] };
    expect(params.tools).toHaveLength(1);
    expect(params.messages[0]!.content).toContain("APPROFONDIMENTO");
    expect(out.answer.origin).toBe("web");
    expect(out.usage.local).toBeUndefined();
  });

  it("se l'approfondimento fallisce interroga la base locale e lo dichiara", async () => {
    const { client, create } = fakeClient(new Error("timeout"), localReply("answered", "Dalla base.", [ref]));
    const out = await askGuide(client, loaded, { ...req, depth: "deep" }, gate());
    expect(create).toHaveBeenCalledTimes(2);
    expect(out.answer).toMatchObject({ origin: "local", webUnavailable: true, citations: [ref] });
    expect(out.answer.answer).toMatch(/^Dalla base\. /);
  });

  it("l'approfondimento senza ricerca consentita usa la sola base", async () => {
    const { client, create } = fakeClient(localReply("answered", "Dalla base.", [ref]));
    const out = await askGuide(client, loaded, { ...req, depth: "deep" }, gate({ permitted: () => false }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.answer.webUnavailable).toBe(true);
  });

  it("ogni risposta porta il contatore dei consumi (somma delle chiamate)", async () => {
    const { client } = fakeClient(
      localReply("not_in_knowledge", "Non lo so."),
      webReply([{ type: "text", text: "Fu ricostruito.", citations: [cite("https://www.unige.it/x", "Studio")] }]),
    );
    const out = await askGuide(client, loaded, req, gate());
    expect(out.answer.meter).toMatchObject({ calls: 2, input: 9000, output: 700, webSearches: 1, models: ["claude-opus-5-5"] });
    // 9000 token in ingresso a 4 $/M + 700 in uscita a 20 $/M + 1 ricerca a 0,01 $
    expect(out.answer.meter?.costUsd).toBeCloseTo(0.036 + 0.014 + 0.01, 5);
    expect(out.costUsd).toBe(out.answer.meter?.costUsd);
  });

  it("riprende i turni sospesi (pause_turn) rimandando il messaggio dell'assistente", async () => {
    const paused = searchBlocks([{ url: "https://museo.example.it/a", title: "Museo" }]);
    const { client, create } = fakeClient(
      localReply("partial", "In parte.", [ref]),
      webReply(paused, "pause_turn"),
      webReply([{ type: "text", text: "Risposta completa.", citations: [cite("https://museo.example.it/a", "Museo")] }], "end_turn", 1),
    );
    const out = await askGuide(client, loaded, req, gate());
    expect(create).toHaveBeenCalledTimes(3);
    const third = create.mock.calls[2]![0] as unknown as { messages: { role: string }[]; tools: { max_uses: number }[] };
    expect(third.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(third.tools[0]!.max_uses).toBe(2);
    expect(out.answer).toMatchObject({ origin: "web", webSearches: 2 });
  });

  it("se la ricerca fallisce risponde con la base locale e lo dichiara", async () => {
    const { client } = fakeClient(localReply("partial", "So solo questo.", [ref]), new Error("timeout"));
    const out = await askGuide(client, loaded, req, gate());
    expect(out.answer).toMatchObject({ status: "partial", origin: "local", citations: [ref], webUnavailable: true });
    expect(out.answer.answer).toMatch(/^So solo questo\. .*fonti online/);
    expect(out.web).toMatchObject({ attempted: true, error: "timeout" });
  });

  it("una risposta con ricerca senza alcuna fonte citata non si mostra", async () => {
    const { client } = fakeClient(localReply("not_in_knowledge", "Non lo so."), webReply([{ type: "text", text: "Fu costruito nel 1200 da un re." }]));
    const out = await askGuide(client, loaded, req, gate());
    expect(out.answer.origin).toBe("local");
    expect(out.answer.answer).not.toContain("1200");
    expect(out.answer.answer).toMatch(/non ho trovato fonti attendibili/);
  });

  it("non cerca se i limiti di uso sono raggiunti, se il modello non la supporta o se è disattivata", async () => {
    for (const g of [gate({ permitted: () => false }), gate({ supported: false })]) {
      const { client, create } = fakeClient(localReply("not_in_knowledge", "Non lo so."));
      const out = await askGuide(client, loaded, req, g);
      expect(create).toHaveBeenCalledTimes(1);
      expect(out.answer.webUnavailable).toBe(true);
    }
    const { client, create } = fakeClient(localReply("not_in_knowledge", "Non lo so."));
    const out = await askGuide(client, loaded, req, gate({ config: webConfig({ ASK_WEB_ENABLED: "off" }) }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.answer).toMatchObject({ status: "not_in_knowledge", answer: "Non lo so." });
  });

  it("senza configurazione web la guida funziona come prima", async () => {
    const { client, create } = fakeClient(localReply("not_in_knowledge", "Non lo so."));
    const out = await askGuide(client, loaded, req);
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.answer).toMatchObject({ status: "not_in_knowledge", origin: "local" });
  });

  it("le domande fuori tema non attivano la ricerca", async () => {
    const { client, create } = fakeClient(localReply("off_topic", "Parliamo della visita."));
    const out = await askGuide(client, loaded, req, gate());
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.answer.answer).toBe("Parliamo della visita.");
  });
});
