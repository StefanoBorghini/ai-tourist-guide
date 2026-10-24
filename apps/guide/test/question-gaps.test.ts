import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askRequestSchema, type AskAnswer, type AskRequest } from "../lib/ask.ts";
import { GAP_QUESTION_CHARS, gapKind, gapRecord, normalizeQuestion } from "../lib/question-gaps.ts";

/** Registro delle domande senza risposta: cosa si registra e in che forma (logica pura) e chiamata al database. */
const req = (over: Partial<AskRequest> = {}): AskRequest =>
  ({ ...askRequestSchema.parse({ destination: "zz.prova", locale: "it", question: "Chi costruì il castello?" }), ...over }) as AskRequest;
const answer = (status: AskAnswer["status"], over: Partial<AskAnswer> = {}): AskAnswer => ({ status, answer: "x", citations: [], ...over });
const input = (a: AskAnswer, rejected?: string) => ({ answer: a, rejected, kbHash: "kb-1", prompt: "p-1", isPlace: (r: string) => r === "zz.prova:castello" });

describe("quali domande si registrano", () => {
  it("dall'esito deciso dal sistema, non dalle parole della domanda", () => {
    expect(gapKind(req(), answer("not_in_knowledge"))).toBe("not_in_knowledge");
    expect(gapKind(req(), answer("partial"))).toBe("partial");
    expect(gapKind(req(), answer("rejected", { checkReason: "numero non citato" }))).toBe("rejected");
    expect(gapKind(req(), answer("answered", { origin: "web" }))).toBe("web_answer");
    expect(gapKind(req(), answer("not_in_knowledge", { webUnavailable: true }))).toBe("web_unavailable");
    // Una domanda che «sembra» senza risposta ma ha avuto risposta completa non si registra.
    expect(gapKind(req({ question: "Non so niente di questo, me lo dici?" }), answer("answered"))).toBeNull();
  });
  it("mai le risposte complete, fuori tema, le emergenze, i servizi non disponibili e gli approfondimenti", () => {
    for (const s of ["answered", "off_topic", "safety", "unavailable"] as const) expect(gapKind(req(), answer(s)), s).toBeNull();
    expect(gapKind(req({ depth: "deep" }), answer("partial", { origin: "web" }))).toBeNull();
    expect(gapKind(req({ depth: "deep" }), answer("not_in_knowledge"))).toBeNull();
  });
  it("le domande che rimandano a un luogo non indicato sono «ambigue», non lacune della base", () => {
    expect(gapKind(req({ question: "Perché è stato costruito proprio qui?" }), answer("not_in_knowledge"))).toBe("ambiguous");
    expect(gapKind(req({ question: "Perché è stato costruito proprio qui?", currentPlace: "zz.prova:castello" }), answer("not_in_knowledge"))).toBe("not_in_knowledge");
  });
});

describe("forma della riga", () => {
  it("testo mascherato e accorciato, chiave normalizzata, solo riferimenti del pack", () => {
    const r = gapRecord(
      req({ question: "Scrivimi a mario.rossi@example.it o al +39 347 123 4567: il castello è aperto? Codice RSSMRA85T10A562S", currentPlace: "zz.prova:castello", history: [{ question: "q", answer: "risposta precedente" }], position: { lon: 9.8, lat: 44, accuracyM: 5, simulated: false } }),
      input(answer("not_in_knowledge")),
    )!;
    expect(r).toEqual({
      pack: "zz.prova",
      locale: "it",
      question: "Scrivimi a [email] o al [telefono]: il castello è aperto? Codice [codice fiscale]",
      key: "scrivimi a email o al telefono il castello è aperto codice codice fiscale",
      kind: "not_in_knowledge",
      place: "zz.prova:castello",
      selected: null,
      reason: null,
      webSources: [],
      kbHash: "kb-1",
      prompt: "p-1",
    });
    // Niente cronologia, posizione o risposta nella riga.
    const all = JSON.stringify(r);
    for (const leak of ["mario", "347", "RSSMRA", "risposta precedente", "44", "9.8"]) expect(all).not.toContain(leak);
  });
  it("domande uguali a meno di maiuscole, spazi e punteggiatura hanno la stessa chiave", () => {
    const a = gapRecord(req({ question: "Chi costruì il CASTELLO?!" }), input(answer("partial")))!;
    const b = gapRecord(req({ question: "  chi   costruì il castello " }), input(answer("partial")))!;
    expect(a.key).toBe(b.key);
    expect(a.key).toBe("chi costruì il castello");
    expect(normalizeQuestion("Dov'è  la Grotta?")).toBe("dov è la grotta");
  });
  it("al massimo 300 caratteri, cinque fonti web (solo indirizzo e titolo) e motivo dello scarto mascherato", () => {
    const long = "a".repeat(400);
    const r = gapRecord(req({ question: long }), input(answer("partial")));
    // La domanda arriva già limitata dallo schema della richiesta; qui comunque non si supera il limite del registro.
    expect(r!.question.length).toBeLessThanOrEqual(GAP_QUESTION_CHARS);
    const sources = Array.from({ length: 7 }, (_, i) => ({ url: `https://s${i}.example.it/`, title: `T${i}`, site: "x", tier: 3 as const, citedText: "brano" }));
    const w = gapRecord(req(), input(answer("answered", { origin: "web", webSources: sources })))!;
    expect(w.webSources).toHaveLength(5);
    expect(w.webSources[0]).toEqual({ url: "https://s0.example.it/", title: "T0" });
    // Del motivo dello scarto resta solo il tipo di controllo: i dettagli riprendono testo della risposta del modello.
    const rj = gapRecord(req(), input(answer("rejected"), "citazioni inesistenti: pack:mario-rossi, 3471234567"))!;
    expect(rj.reason).toBe("citazioni inesistenti");
  });
  it("solo luoghi della base: un testo qualsiasi al posto del riferimento non entra nel registro", () => {
    const r = gapRecord(req({ currentPlace: "Mario Rossi, via Roma 3", selectedPlace: "zz.prova:castello" }), input(answer("partial")))!;
    expect(r.place).toBeNull();
    expect(r.selected).toBe("zz.prova:castello");
    expect(JSON.stringify(r)).not.toContain("Mario");
  });
  it("nessuna riga per le domande da non registrare", () => {
    expect(gapRecord(req(), input(answer("answered")))).toBeNull();
    expect(gapRecord(req(), input(answer("safety")))).toBeNull();
  });
});

// ------------------------------------------------------------------ chiamata al database

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  createClient: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => {
    h.createClient(...args);
    return { rpc: (...a: unknown[]) => ({ abortSignal: (signal: AbortSignal) => h.rpc(...a, signal) }) };
  },
}));

const KEY = "chiave-di-servizio-segreta-0123456789";
const env = { QUESTION_GAPS_ENABLED: "1", NEXT_PUBLIC_SUPABASE_URL: "https://progetto.supabase.co", SUPABASE_SERVICE_ROLE_KEY: KEY };

describe("registrazione nel database", () => {
  beforeEach(() => {
    vi.resetModules();
    h.rpc.mockReset();
    h.createClient.mockReset();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());
  const server = () => import("../lib/question-gaps-server.ts");
  const logs = () =>
    [console.info, console.warn, console.error].flatMap((f) => (f as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))).join("\n");
  const gap = () => gapRecord(req({ question: "Chi costruì il castello?" }), input(answer("not_in_knowledge")))!;

  it("spento senza QUESTION_GAPS_ENABLED=1, o senza indirizzo e chiave validi", async () => {
    const { questionGapsConfig } = await server();
    expect(questionGapsConfig({ ...env, QUESTION_GAPS_ENABLED: undefined })).toBeNull();
    expect(questionGapsConfig({ ...env, QUESTION_GAPS_ENABLED: "0" })).toBeNull();
    expect(questionGapsConfig({ ...env, SUPABASE_SERVICE_ROLE_KEY: "corta" })).toBeNull();
    expect(questionGapsConfig({ ...env, NEXT_PUBLIC_SUPABASE_URL: "http://insicuro.example" })).toBeNull();
    expect(questionGapsConfig(env)).toEqual({ url: env.NEXT_PUBLIC_SUPABASE_URL, serviceKey: KEY });
    expect(logs()).not.toContain(KEY);
  });

  it("chiama solo gap_record, con un tempo massimo, e registra l'esito senza testo né chiave", async () => {
    h.rpc.mockResolvedValueOnce({ data: "created", error: null });
    const { questionGapsConfig, recordQuestionGap } = await server();
    expect(await recordQuestionGap(questionGapsConfig(env)!, gap())).toBe("created");
    expect(h.rpc).toHaveBeenCalledTimes(1);
    const [fn, args, signal] = h.rpc.mock.calls[0]!;
    expect(fn).toBe("gap_record");
    expect(args).toMatchObject({ p_pack: "zz.prova", p_locale: "it", p_question: "Chi costruì il castello?", p_key: "chi costruì il castello", p_kind: "not_in_knowledge" });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(logs()).toContain('"result":"created"');
    expect(logs()).not.toContain("castello");
    expect(logs()).not.toContain(KEY);
  });

  it("un errore del database, un'eccezione o un tempo scaduto non lanciano: esito «error», log senza testo né chiave", async () => {
    const { questionGapsConfig, recordQuestionGap } = await server();
    const config = questionGapsConfig(env)!;
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "42501", message: `permesso negato per ${KEY}` } });
    expect(await recordQuestionGap(config, gap())).toBe("error");
    h.rpc.mockRejectedValueOnce(new Error(`rete giù ${KEY}`));
    expect(await recordQuestionGap(config, gap())).toBe("error");
    h.rpc.mockRejectedValueOnce(Object.assign(new Error("scaduto"), { name: "TimeoutError" }));
    expect(await recordQuestionGap(config, gap())).toBe("error");
    expect(logs()).toContain('"code":"42501"');
    expect(logs()).toContain('"code":"timeout"');
    expect(logs()).not.toContain(KEY);
    expect(logs()).not.toContain("castello");
  });

  it("fuori da una richiesta di Next la registrazione parte subito, senza eccezioni", async () => {
    h.rpc.mockResolvedValueOnce({ data: "updated", error: null });
    const { questionGapsConfig, scheduleQuestionGap } = await server();
    expect(() => scheduleQuestionGap(questionGapsConfig(env)!, gap())).not.toThrow();
    await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
  });
});
