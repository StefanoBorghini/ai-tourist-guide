import { describe, expect, it } from "vitest";
import { formatEuro, onSale, parseEuro, priceProblem, type CatalogProduct } from "../lib/studio/catalog.ts";

describe("prezzi in euro", () => {
  it("da euro scritti a mano a centesimi interi", () => {
    expect(parseEuro("4,99")).toBe(499);
    expect(parseEuro("4.99")).toBe(499);
    expect(parseEuro("5")).toBe(500);
    expect(parseEuro("12,5")).toBe(1250);
    expect(parseEuro(" € 2,99 ")).toBe(299);
    expect(parseEuro("0,50")).toBe(50);
  });
  it("niente arrotondamenti nascosti né formati ambigui", () => {
    for (const bad of ["", "abc", "4,999", "1.000,00", "-3", "4,", ",99", "1e3", "4 99x"]) expect(parseEuro(bad), bad).toBeNull();
  });
  it("limiti del database: da 0,50 € a 999 €", () => {
    expect(priceProblem(49)).toMatch(/limiti/);
    expect(priceProblem(50)).toBeNull();
    expect(priceProblem(99_900)).toBeNull();
    expect(priceProblem(99_901)).toMatch(/limiti/);
    expect(priceProblem(null)).toMatch(/non valido/);
  });
  it("formato italiano", () => {
    expect(formatEuro(499)).toBe("4,99 €");
    expect(formatEuro(50)).toBe("0,50 €");
    expect(formatEuro(99_900)).toBe("999,00 €");
  });
});

describe("in vendita", () => {
  const p: CatalogProduct = {
    id: "x", slug: "x", kind: "explore", labels: { it: { name: "X" } }, status: "active", availability: "available", sortOrder: 0,
    route: null, routes: [], published: { amount: 499, at: "2026-10-14" }, draft: null, paidOrders: 0, problem: null,
  };
  it("solo attivo, non nascosto, con prezzo pubblicato e coerente con l'accesso", () => {
    expect(onSale(p)).toBe(true);
    expect(onSale({ ...p, status: "draft" })).toBe(false);
    expect(onSale({ ...p, availability: "hidden" })).toBe(false);
    expect(onSale({ ...p, availability: "sold_out" })).toBe(true);
    expect(onSale({ ...p, published: null, draft: { amount: 499 } })).toBe(false);
    expect(onSale({ ...p, problem: "esplorazione gratuita" })).toBe(false);
  });
});
