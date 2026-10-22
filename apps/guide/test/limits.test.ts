import { describe, expect, it } from "vitest";
import { SpendGuard, WindowLimiter, dailyBudgetUsd } from "../lib/limits.ts";

describe("limite per indirizzo", () => {
  it("conta gli usi nella finestra e li dimentica quando scadono", () => {
    const l = new WindowLimiter(2, 1000);
    expect(l.hit("a", 0)).toBe(false);
    expect(l.hit("a", 10)).toBe(false);
    expect(l.hit("a", 20)).toBe(true);
    expect(l.allows("a", 500)).toBe(false);
    expect(l.allows("a", 1500)).toBe(true);
  });

  it("molti indirizzi nuovi non azzerano i limiti di chi è già oltre", () => {
    const l = new WindowLimiter(1, 60_000, 100);
    l.hit("abuso", 0);
    l.hit("abuso", 1);
    expect(l.allows("abuso", 2)).toBe(false);
    // L'attaccante usa l'indirizzo bloccato per ultimo, poi inonda la mappa con altri indirizzi.
    for (let i = 0; i < 99; i++) l.hit(`altro-${i}`, 3);
    l.hit("abuso", 4);
    for (let i = 99; i < 150; i++) l.hit(`altro-${i}`, 5);
    expect(l.size).toBeLessThanOrEqual(100);
    // Le chiavi tolte sono le meno recenti, non tutte: l'indirizzo bloccato resta bloccato.
    expect(l.size).toBeGreaterThan(50);
    expect(l.allows("abuso", 6)).toBe(false);
  });

  it("toglie per prime le chiavi senza usi recenti", () => {
    const l = new WindowLimiter(5, 1000, 3);
    l.hit("vecchia", 0);
    l.hit("b", 2000);
    l.hit("c", 2000);
    l.hit("d", 2000);
    expect(l.size).toBe(3);
    expect(l.allows("b", 2001)).toBe(true);
  });
});

describe("tetto di spesa giornaliero", () => {
  const day = Date.UTC(2026, 9, 22, 12);

  it("blocca quando la riserva prevista supererebbe il tetto", () => {
    const s = new SpendGuard(1);
    expect(s.allows(0.4, day)).toBe(true);
    s.record(0.7, day);
    expect(s.allows(0.4, day)).toBe(false);
    expect(s.allows(0.3, day)).toBe(true);
    expect(s.spentToday(day)).toBe(0.7);
  });

  it("si azzera al cambio di giorno (UTC)", () => {
    const s = new SpendGuard(1);
    s.record(1, day);
    expect(s.allows(0.1, day)).toBe(false);
    expect(s.allows(0.1, day + 24 * 3_600_000)).toBe(true);
  });

  it("0 vuol dire nessun tetto; i valori non validi non contano", () => {
    const s = new SpendGuard(0);
    s.record(1000, day);
    expect(s.allows(1000, day)).toBe(true);
    const t = new SpendGuard(1);
    t.record(Number.NaN, day);
    t.record(-5, day);
    expect(t.spentToday(day)).toBe(0);
  });

  it("legge il tetto dalle variabili d'ambiente, con 10 $ per default", () => {
    expect(dailyBudgetUsd({})).toBe(10);
    expect(dailyBudgetUsd({ ASK_DAILY_BUDGET_USD: "2.5" })).toBe(2.5);
    expect(dailyBudgetUsd({ ASK_DAILY_BUDGET_USD: "0" })).toBe(0);
    expect(dailyBudgetUsd({ ASK_DAILY_BUDGET_USD: "-3" })).toBe(10);
    expect(dailyBudgetUsd({ ASK_DAILY_BUDGET_USD: "molto" })).toBe(10);
  });
});
