import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventsReply, NO_STORE, parseEventsQuery, PUBLIC_CACHE, rpcArgs, type EventsRpc } from "../lib/events-api.ts";

const q = (s: string) => new URLSearchParams(s);
const T = "territory=it.liguria.sp.portovenere";
const okData = { territory: { id: "it.liguria.sp.portovenere", timezone: "Europe/Rome" }, today: "2026-10-20", range: { from: "2026-10-20", to: "2026-10-26" }, lang: "it", events: [] };

describe("parametri dell'API degli eventi", () => {
  it("territorio obbligatorio e ben formato; il resto lo decide il database", () => {
    expect(parseEventsQuery(q(T))).toEqual({ territory: "it.liguria.sp.portovenere", from: null, to: null, lang: null });
    expect(parseEventsQuery(q(""))).toBeNull();
    expect(parseEventsQuery(q("territory=IT.Liguria"))).toBeNull();
    expect(parseEventsQuery(q("territory=it.liguria;drop"))).toBeNull();
    expect(parseEventsQuery(q(`territory=${"a".repeat(121)}`))).toBeNull();
  });

  it("periodo: date vere, al massimo 14 giorni estremi inclusi, niente fine senza inizio", () => {
    expect(parseEventsQuery(q(`${T}&from=2026-10-20&to=2026-11-02`))).toMatchObject({ from: "2026-10-20", to: "2026-11-02" });
    expect(parseEventsQuery(q(`${T}&from=2026-10-20&to=2026-11-03`))).toBeNull();
    expect(parseEventsQuery(q(`${T}&from=2026-10-21&to=2026-10-20`))).toBeNull();
    expect(parseEventsQuery(q(`${T}&from=2026-02-30`))).toBeNull();
    expect(parseEventsQuery(q(`${T}&to=2026-10-25`))).toBeNull();
    expect(parseEventsQuery(q(`${T}&from=&to=`))).toMatchObject({ from: null, to: null });
  });

  it("lingua di due lettere", () => {
    expect(parseEventsQuery(q(`${T}&lang=en`))).toMatchObject({ lang: "en" });
    expect(parseEventsQuery(q(`${T}&lang=english`))).toBeNull();
    expect(parseEventsQuery(q(`${T}&lang=EN`))).toBeNull();
  });

  it("argomenti della funzione del database", () => {
    expect(rpcArgs({ territory: "a.b", from: "2026-10-20", to: null, lang: "it" })).toEqual({ p_pack: "a.b", p_from: "2026-10-20", p_to: null, p_lang: "it" });
  });
});

describe("esiti e cache", () => {
  const rpcWith = (result: Awaited<ReturnType<EventsRpc>>) => vi.fn(async () => result);

  it("200 con versione e cache pubblica breve", async () => {
    const rpc = rpcWith({ data: okData, error: null });
    const r = await eventsReply(q(`${T}&lang=it`), rpc);
    expect(r).toEqual({ status: 200, body: { version: 1, ...okData }, cacheControl: PUBLIC_CACHE });
    expect(rpc).toHaveBeenCalledWith({ p_pack: "it.liguria.sp.portovenere", p_from: null, p_to: null, p_lang: "it" });
    expect(PUBLIC_CACHE).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=300");
  });

  it("parametri malformati: 400 senza interrogare il database", async () => {
    const rpc = rpcWith({ data: okData, error: null });
    expect(await eventsReply(q("territory=x;y"), rpc)).toMatchObject({ status: 400, body: { error: "parametri" }, cacheControl: NO_STORE });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("parametri rifiutati dal database (22023): 400", async () => {
    const r = await eventsReply(q(`${T}&lang=fr`), rpcWith({ data: null, error: { code: "22023" } }));
    expect(r).toMatchObject({ status: 400, body: { error: "parametri" }, cacheControl: NO_STORE });
  });

  it("territorio sconosciuto o non pubblicato: 404", async () => {
    expect(await eventsReply(q(T), rpcWith({ data: null, error: null }))).toMatchObject({ status: 404, body: { error: "territorio" }, cacheControl: NO_STORE });
  });

  it("errore del database o della rete: 503 generico, senza dettagli", async () => {
    const r = await eventsReply(q(T), rpcWith({ data: null, error: { code: "PGRST301", message: "JWT expired at db.interno:5432" } as never }));
    expect(r).toEqual({ status: 503, body: { version: 1, error: "non_disponibile" }, cacheControl: NO_STORE });
    expect(JSON.stringify(r)).not.toContain("interno");
    const thrown = await eventsReply(q(T), vi.fn(async () => { throw new Error("rete giù: 10.0.0.1"); }));
    expect(thrown).toEqual({ status: 503, body: { version: 1, error: "non_disponibile" }, cacheControl: NO_STORE });
  });

  it("risposta inattesa dal database: 503, mai in cache", async () => {
    expect(await eventsReply(q(T), rpcWith({ data: [1, 2], error: null }))).toMatchObject({ status: 503, cacheControl: NO_STORE });
  });

  it("Supabase non configurato: 503", async () => {
    expect(await eventsReply(q(T), null)).toMatchObject({ status: 503, body: { error: "non_configurato" }, cacheControl: NO_STORE });
  });

  it("nessun evento: 200 con lista vuota", async () => {
    const r = await eventsReply(q(T), rpcWith({ data: okData, error: null }));
    expect(r.status).toBe(200);
    expect(r.body.events).toEqual([]);
  });
});

// ------------------------------------------------------------------ route con Supabase finto
const h = vi.hoisted(() => ({
  createClient: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: h.createClient.mockImplementation(() => ({ rpc: h.rpc })),
}));

describe("route /api/v1/events", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    h.createClient.mockClear();
    h.rpc.mockReset();
  });

  it("client anonimo senza sessione e intestazioni di cache sulla risposta", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://progetto.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "chiave-anonima-finta");
    h.rpc.mockResolvedValue({ data: okData, error: null });
    const { GET } = await import("../app/api/v1/events/route.ts");
    const res = await GET(new Request(`https://guida.example/api/v1/events?${T}&from=2026-10-20&to=2026-10-26&lang=it`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(PUBLIC_CACHE);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ version: 1, ...okData });
    expect(h.createClient).toHaveBeenCalledWith("https://progetto.supabase.co", "chiave-anonima-finta", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    expect(h.rpc).toHaveBeenCalledWith("public_local_events", { p_pack: "it.liguria.sp.portovenere", p_from: "2026-10-20", p_to: "2026-10-26", p_lang: "it" });
  });

  it("senza configurazione: 503 e nessun client", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const { GET } = await import("../app/api/v1/events/route.ts");
    const res = await GET(new Request(`https://guida.example/api/v1/events?${T}`));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(h.createClient).not.toHaveBeenCalled();
  });

  it("i file dell'API non leggono cookie o intestazioni, non usano la chiave di servizio né l'AI", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    for (const file of ["app/api/v1/events/route.ts", "lib/events-api.ts", "lib/public-supabase.ts"]) {
      const src = readFileSync(resolve(root, file), "utf8");
      expect(src, file).not.toMatch(/next\/headers|cookies\(|SERVICE_ROLE|serviceKey|anthropic|ask-server|lib\/ask/i);
    }
  });
});
