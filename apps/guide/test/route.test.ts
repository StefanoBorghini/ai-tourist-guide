import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La route senza modello configurato: le emergenze devono avere comunque il 112, subito.
 * Nessuna chiamata di rete: senza configurazione il modello non esiste e i contenuti non si leggono.
 */
const post = (body: unknown) =>
  new Request("http://localhost/api/guide/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function route() {
  vi.resetModules();
  return import("../app/api/guide/ask/route.ts");
}

describe("POST /api/guide/ask", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ASK_PROVIDER", "");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("un'emergenza riceve il 112 subito, anche senza modello configurato", async () => {
    const { POST } = await route();
    for (const [locale, question] of [["it", "Mi sento male, ho un forte dolore al petto"], ["en", "My son is missing"]] as const) {
      const res = await POST(post({ destination: "qualunque", locale, question }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ status: "safety", citations: [] });
      expect(body.answer).toContain("112");
    }
  });

  it("un'emergenza non consuma i limiti per indirizzo", async () => {
    const { POST } = await route();
    for (let i = 0; i < 30; i++) {
      const res = await POST(post({ destination: "x", locale: "it", question: "Aiuto!" }));
      expect(res.status).toBe(200);
    }
  });

  it("senza configurazione le altre domande rispondono 503, e una richiesta non valida 400", async () => {
    const { POST } = await route();
    expect((await POST(post({ destination: "x", locale: "it", question: "Cos'è il castello?" }))).status).toBe(503);
    expect((await POST(post({ destination: "x", locale: "fr", question: "Bonjour" }))).status).toBe(400);
  });
});
