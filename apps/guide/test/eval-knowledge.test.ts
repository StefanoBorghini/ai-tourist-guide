import { appendFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPackKnowledge } from "../lib/eval-knowledge.ts";

/**
 * Base per la valutazione locale (ask:eval --pack, gaia:examples --pack): compilata in memoria da una cartella,
 * con o senza i contenuti a pagamento, e mai raggiungibile dal percorso dei visitatori.
 */
const here = dirname(fileURLToPath(import.meta.url));
const synthetic = resolve(here, "../../../territories/_synthetic");
const destination = "it.test.borgo-di-prova";
let dir = "";
let configPath = "";
let configBefore = "";

beforeAll(() => {
  // Copia del territorio sintetico con l'esplorazione a pagamento, in una cartella temporanea.
  dir = mkdtempSync(join(tmpdir(), "eval-knowledge-"));
  cpSync(synthetic, dir, { recursive: true });
  configPath = join(dir, destination, "config.yaml");
  appendFileSync(configPath, "access:\n  explore: premium\n");
  configBefore = readFileSync(configPath, "utf8");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("base di conoscenza per la valutazione locale", () => {
  it("base pubblica: come in produzione, senza i contenuti a pagamento", () => {
    const pub = loadPackKnowledge(dir, destination, "it", { full: false, allowFictional: true });
    const full = loadPackKnowledge(dir, destination, "it", { full: true, allowFictional: true });
    expect(full.content.assertions.length).toBeGreaterThan(pub.content.assertions.length);
    expect(pub.label).toContain("base pubblica");
    expect(full.label).toContain("base completa");
    expect(full.knowledge).toContain("BASE DI CONOSCENZA");
    expect(full.kbHash).not.toBe(pub.kbHash);
  });

  it("la base completa si costruisce in memoria: il file di configurazione non cambia", () => {
    loadPackKnowledge(dir, destination, "it", { full: true, allowFictional: true });
    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
  });

  it("senza config.access le due basi coincidono", () => {
    const a = loadPackKnowledge(synthetic, destination, "it", { full: false, allowFictional: true });
    const b = loadPackKnowledge(synthetic, destination, "it", { full: true, allowFictional: true });
    expect(b.kbHash).toBe(a.kbHash);
  });

  it("un territorio inventato non si compila senza allowFictional (come per la pubblicazione)", () => {
    expect(() => loadPackKnowledge(synthetic, destination, "it", { full: false })).toThrow(/fittizio/);
  });

  it("nessun file dell'app servita ai visitatori importa il modulo di valutazione", () => {
    const appDir = resolve(here, "..");
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (name === "node_modules" || name === ".next" || name === "test" || name === "scripts") continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs|js)$/.test(name) && !p.endsWith("eval-knowledge.ts") && readFileSync(p, "utf8").includes("eval-knowledge")) offenders.push(p);
      }
    };
    walk(appDir);
    expect(offenders).toEqual([]);
  });
});
