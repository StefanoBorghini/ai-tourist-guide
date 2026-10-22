import { describe, expect, it } from "vitest";
import { PURCHASE_WATCH_MS, readStamp, watchingPurchase } from "../lib/purchase-watch.ts";

const t0 = 1_800_000_000_000;

describe("attesa dello sblocco dopo un acquisto", () => {
  it("istanti salvati: solo numeri interi", () => {
    expect(readStamp(String(t0))).toBe(t0);
    expect(readStamp(null)).toBeNull();
    expect(readStamp("")).toBeNull();
    expect(readStamp("1e12")).toBeNull();
    expect(readStamp("-5")).toBeNull();
  });

  it("si aspetta solo dopo una partenza recente verso la cassa", () => {
    expect(watchingPurchase(null, null, null, t0)).toBe(false);
    expect(watchingPurchase(t0, null, null, t0 + 60_000)).toBe(true);
    expect(watchingPurchase(t0, null, t0 + 50_000, t0 + PURCHASE_WATCH_MS)).toBe(true);
    expect(watchingPurchase(t0, null, null, t0 + PURCHASE_WATCH_MS + 1)).toBe(false);
    // Orologio spostato indietro: non si resta in attesa.
    expect(watchingPurchase(t0, null, null, t0 - 1)).toBe(false);
  });

  it("dopo la conferma della pagina dell'ordine basta una richiesta successiva", () => {
    const done = t0 + 30_000;
    expect(watchingPurchase(t0, done, null, done + 1)).toBe(true);
    expect(watchingPurchase(t0, done, done - 1, done + 1)).toBe(true);
    expect(watchingPurchase(t0, done, done + 500, done + 1000)).toBe(false);
    // Una conferma di un acquisto precedente non chiude l'attesa di quello nuovo.
    expect(watchingPurchase(t0, t0 - 10, t0 + 5, t0 + 10)).toBe(true);
  });
});
