import { createServer, type Server } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ANSWER_JSON_SCHEMA } from "../lib/ask.ts";
import { fetchWithoutHeaderLimit } from "../lib/eval-fetch.ts";
import { OpenAICompatibleAdapter, type ModelRequest } from "../lib/model.ts";

/** Server locale finto, come Ollama: risponde solo a risposta finita, dopo `delayMs`. */
const here = dirname(fileURLToPath(import.meta.url));
let server: Server;
let base: string;
const seen: { method?: string; url?: string; headers: Record<string, unknown>; body: string }[] = [];
let delayMs = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "modello-locale", choices: [{ finish_reason: "stop", message: { content: '{"status":"off_topic","answer":"Parliamo della visita.","citations":[]}', refusal: null } }] }));
      }, delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const request: ModelRequest = {
  system: [{ text: "regole" }, { text: "persona" }, { text: "base", cache: true }],
  user: "domanda",
  jsonSchema: ANSWER_JSON_SCHEMA,
  maxTokens: 4000,
  timeoutMs: 5_000,
};

describe("fetch delle valutazioni locali (senza il limite di 5 minuti di Node)", () => {
  it("con l'adattatore compatibile OpenAI manda la stessa richiesta e legge la risposta", async () => {
    delayMs = 50;
    seen.length = 0;
    const out = await new OpenAICompatibleAdapter(base, null, "modello-locale", fetchWithoutHeaderLimit).generate(request);
    expect(out).toMatchObject({ stop: "end", model: "modello-locale", usage: null });
    expect(JSON.parse(out.text)).toMatchObject({ status: "off_topic" });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/v1/chat/completions" });
    expect(seen[0]!.headers).not.toHaveProperty("authorization");
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ model: "modello-locale", max_tokens: 4000 });
  });

  it("il tempo concesso vale ancora: oltre, è un errore «timeout»", async () => {
    delayMs = 2_000;
    const error = await new OpenAICompatibleAdapter(base, null, "modello-locale", fetchWithoutHeaderLimit).generate({ ...request, timeoutMs: 100 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ModelError", kind: "timeout" });
  });

  it("server spento: errore di rete («unavailable»), non un tempo scaduto", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const error = await new OpenAICompatibleAdapter(`http://127.0.0.1:${port}/v1`, null, "m", fetchWithoutHeaderLimit).generate(request).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ModelError", kind: "unavailable" });
  });

  it("il limite interno del fetch di Node diventa «timeout», non un errore di rete", async () => {
    const nodeLimit = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
    });
    const error = await new OpenAICompatibleAdapter(base, null, "m", nodeLimit).generate(request).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ModelError", kind: "timeout" });
  });

  it("solo gli script lo usano: nessun file dell'app servita ai visitatori lo importa", () => {
    const appDir = resolve(here, "..");
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (name === "node_modules" || name === ".next" || name === "test" || name === "scripts") continue;
        if (statSync(p).isDirectory()) walk(p);
        // Solo le importazioni: lib/model.ts lo nomina in un messaggio, senza importarlo.
        else if (/\.(ts|tsx|mjs|js)$/.test(name) && !p.endsWith("eval-fetch.ts") && /(?:from|import)\s*\(?\s*["'][^"']*eval-fetch(?:\.ts)?["']/.test(readFileSync(p, "utf8"))) offenders.push(p);
      }
    };
    walk(appDir);
    expect(offenders).toEqual([]);
    expect(readFileSync(resolve(appDir, "scripts/ask-eval.ts"), "utf8")).toContain("modelsFromEnv(process.env, fetchWithoutHeaderLimit)");
  });
});
