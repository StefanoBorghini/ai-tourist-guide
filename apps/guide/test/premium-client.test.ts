import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPremium, syncPremium } from "../lib/premium-client.ts";

// localStorage del browser, in memoria.
class MemoryStorage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

const MANIFEST = "/pub/zz.borgo/it-full/0a0b0c0d-0000-4000-8000-000000000001/manifest.json";
const stored = () => JSON.stringify({ manifest: MANIFEST, validUntil: Date.now() + 86_400_000, parts: [{ entry: { path: "x", sha256: "a" }, json: "{}" }] });
const grant = (g: Record<string, unknown>) => vi.fn(async () => new Response(JSON.stringify(g), { status: 200 }));

describe("contenuti acquistati: solo per l'account che li ha comprati", () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem("guide-premium:/pub/zz.borgo/it-full", stored());
    storage.setItem("guide-premium:/pub/zz.altro/it-full", stored());
    storage.setItem("guide-lang", "it");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uscita dall'account: tolti tutti i contenuti acquistati, il resto resta", () => {
    clearPremium();
    expect(storage.getItem("guide-premium:/pub/zz.borgo/it-full")).toBeNull();
    expect(storage.getItem("guide-premium:/pub/zz.altro/it-full")).toBeNull();
    expect(storage.getItem("guide-lang")).toBe("it");
  });

  it("il server dice che nessuno è entrato: copia locale cancellata e contenuto di nuovo bloccato", async () => {
    vi.stubGlobal("fetch", grant({ enabled: true, signedIn: false, parts: [], validUntil: null }));
    expect(await syncPremium(MANIFEST)).toEqual([]);
    expect(storage.getItem("guide-premium:/pub/zz.borgo/it-full")).toBeNull();
  });

  it("acquisti spenti o server non raggiungibile: la copia resta (uso senza rete)", async () => {
    vi.stubGlobal("fetch", grant({ enabled: false, signedIn: false, parts: [], validUntil: null }));
    expect(await syncPremium(MANIFEST)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    expect(await syncPremium(MANIFEST)).toBeNull();
    expect(storage.getItem("guide-premium:/pub/zz.borgo/it-full")).not.toBeNull();
  });

  it("un altro account entrato senza quell'acquisto: la parte si cancella", async () => {
    vi.stubGlobal("fetch", grant({ enabled: true, signedIn: true, parts: [], validUntil: Date.now() + 86_400_000 }));
    expect(await syncPremium(MANIFEST)).toEqual([]);
    expect(storage.getItem("guide-premium:/pub/zz.borgo/it-full")).toBeNull();
  });

  it("la pagina d'accesso pulisce il dispositivo dopo uscita ed eliminazione", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const page = readFileSync(resolve(root, "app/account/accedi/page.tsx"), "utf8");
    expect(page).toMatch(/SIGNED_OUT = new Set\(\["uscito", "uscito-ovunque", "eliminato"\]\)/);
    expect(page).toMatch(/<ClearPurchases \/>/);
  });
});
