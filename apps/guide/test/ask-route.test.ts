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
beforeAll(() => {
  const { packs } = loadPacks(resolve(here, "../../../territories/_synthetic"));
  const dest = [...packs.values()].find((p) => p.manifest.kind === "destination")!;
  const content = buildBundle(packs, { destination: dest.manifest.id, locale: "it", allowFictional: true }).content;
  h.loaded = { content, knowledge: buildKnowledge(content), kbHash: "kb-test" } satisfies Loaded;
  destination = content.destination;
  ref = content.assertions[0]!.ref;
});

beforeEach(() => {
  h.create.mockReset();
  h.clientOptions.length = 0;
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
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
