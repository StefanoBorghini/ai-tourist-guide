import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { authorized, isExempt, siteLockDecision, siteLockFromEnv } from "../lib/site-lock.ts";

const basic = (s: string) => `Basic ${Buffer.from(s, "utf8").toString("base64")}`;
const lock = { username: "redazione", password: "prova-è-lunga" };

describe("protezione del sito con nome utente e password", () => {
  it("spenta senza entrambe le variabili", () => {
    expect(siteLockFromEnv({})).toBeNull();
    expect(siteLockFromEnv({ SITE_USERNAME: "a" })).toBeNull();
    expect(siteLockFromEnv({ SITE_PASSWORD: "b" })).toBeNull();
    expect(siteLockFromEnv({ SITE_USERNAME: "  ", SITE_PASSWORD: "b" })).toBeNull();
    expect(siteLockFromEnv({ SITE_USERNAME: " a ", SITE_PASSWORD: "b" })).toEqual({ username: "a", password: "b" });
    expect(siteLockDecision("/", null, null)).toBeNull();
  });

  it("credenziali giuste passano, tutto il resto no", () => {
    expect(authorized(basic("redazione:prova-è-lunga"), lock)).toBe(true);
    expect(authorized(basic("redazione:prova-è-lungA"), lock)).toBe(false);
    expect(authorized(basic("Redazione:prova-è-lunga"), lock)).toBe(false);
    expect(authorized(basic("redazione"), lock)).toBe(false);
    expect(authorized(basic("redazione:prova-è-lunga:x"), lock)).toBe(false);
    expect(authorized("Bearer abc", lock)).toBe(false);
    expect(authorized("Basic !!!", lock)).toBe(false);
    expect(authorized(null, lock)).toBe(false);
    // La password può contenere «:»; il nome utente no.
    expect(authorized(basic("u:p:q"), { username: "u", password: "p:q" })).toBe(true);
  });

  it("senza credenziali: 401 con la richiesta del browser, mai in cache", () => {
    expect(siteLockDecision("/", null, lock)).toEqual({
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="AI Guide", charset="UTF-8"', "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
    });
    for (const p of ["/studio", "/api/v1/events", "/pub/index.json", "/sw.js", "/_next/static/x.js", "/bundles/index.json"]) {
      expect(siteLockDecision(p, null, lock)?.status, p).toBe(401);
    }
  });

  it("solo il webhook di Stripe resta aperto (ha la sua firma)", () => {
    expect(isExempt("/api/stripe/webhook")).toBe(true);
    expect(isExempt("/api/stripe/webhook/")).toBe(true);
    expect(isExempt("/api/stripe/webhookx")).toBe(false);
    expect(isExempt("/api/checkout")).toBe(false);
    expect(siteLockDecision("/api/stripe/webhook", null, lock)).toBeNull();
  });

  it("app installata: alla prima risposta 401 il service worker cancella le copie per l'uso senza rete", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const sw = readFileSync(resolve(root, "public/sw.js"), "utf8");
    expect(sw).toMatch(/response\.status !== 401/);
    expect(sw).toMatch(/caches\.delete/);
    expect((sw.match(/await forgetIfLocked\(response\)/g) ?? []).length).toBe(2);
  });

  it("le credenziali non sono nel codice né in variabili pubbliche", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    for (const f of ["lib/site-lock.ts", "proxy.ts"]) {
      const src = readFileSync(resolve(root, f), "utf8");
      expect(src, f).not.toMatch(/NEXT_PUBLIC_SITE|console\.(log|info|error)\([^)]*SITE_/);
    }
  });
});

describe("proxy con la protezione accesa", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("chiede la password su ogni pagina; con quella giusta la guida passa", async () => {
    vi.stubEnv("SITE_USERNAME", "redazione");
    vi.stubEnv("SITE_PASSWORD", "segreta");
    const { proxy } = await import("../proxy.ts");
    const denied = await proxy(new NextRequest("https://guida.example/"));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toMatch(/^Basic realm=/);
    const ok = await proxy(new NextRequest("https://guida.example/", { headers: { authorization: basic("redazione:segreta") } }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-middleware-next")).toBe("1");
    const hook = await proxy(new NextRequest("https://guida.example/api/stripe/webhook", { method: "POST" }));
    expect(hook.status).toBe(200);
  });

  it("spenta: la guida passa senza credenziali", async () => {
    vi.stubEnv("SITE_USERNAME", "");
    vi.stubEnv("SITE_PASSWORD", "");
    const { proxy } = await import("../proxy.ts");
    expect((await proxy(new NextRequest("https://guida.example/"))).status).toBe(200);
  });
});
