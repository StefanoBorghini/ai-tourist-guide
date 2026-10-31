import { describe, expect, it } from "vitest";
import { formatEuro, listPrice, onSale, parseEuro, priceProblem, subPlaceSaleRows, unitsWithoutProduct, type CatalogProduct } from "../lib/studio/catalog.ts";

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

describe("acquisto progressivo nello Studio", () => {
  const product = (over: Partial<CatalogProduct>): CatalogProduct => ({
    id: "p", slug: "p", kind: "place", labels: {}, status: "active", availability: "available", sortOrder: 0, route: null,
    routes: [], published: null, draft: null, paidOrders: 0, problem: null, ...over,
  });
  it("prezzo di listino: il prezzo proprio pubblicato prima della tariffa; senza nessuno dei due non è in vendita", () => {
    expect(listPrice(product({ published: { amount: 199, at: "x" }, tier: { amount: 299 } }))).toEqual({ amount: 199, source: "own" });
    expect(listPrice(product({ tier: { amount: 299 } }))).toEqual({ amount: 299, source: "tier" });
    expect(onSale(product({ tier: { amount: 299 } }))).toBe(true);
    expect(onSale(product({}))).toBe(false);
  });
  it("contenuti singoli da creare: solo nei luoghi con almeno due contenuti e senza prodotto", () => {
    const places = [
      { id: "1", slug: "borgo", name: "Borgo", sellable: true, isUnit: true, units: 3 },
      { id: "2", slug: "torre", name: "Torre", sellable: false, parent: "borgo", isUnit: true, units: 0 },
      { id: "3", slug: "chiesa", name: "Chiesa", sellable: false, parent: "borgo", isUnit: true, units: 0 },
      { id: "4", slug: "grazie", name: "Grazie", sellable: true, isUnit: true, units: 1 },
      { id: "5", slug: "lapide", name: "Lapide", sellable: false, parent: "borgo", isUnit: false, units: 0 },
    ];
    const products = [product({ kind: "unit", place: { id: "2", slug: "torre" } })];
    // Mai il luogo principale (borgo): si vende intero.
    expect(unitsWithoutProduct({ places, products }).map((p) => p.slug)).toEqual(["chiesa"]);
  });
});

describe("stato di vendita dei sottoluoghi (scheda Vendita)", () => {
  const product = (over: Partial<CatalogProduct>): CatalogProduct => ({
    id: "p", slug: "p", kind: "unit", labels: {}, status: "active", availability: "available", sortOrder: 0, route: null,
    routes: [], published: null, draft: null, paidOrders: 0, problem: null, ...over,
  });
  const D = "it.prova";
  const places = [
    { id: "1", slug: "borgo", name: "Borgo", sellable: true, isUnit: false, units: 3 },
    { id: "2", slug: "torre", name: "Torre", sellable: false, parent: "borgo", isUnit: true, units: 0 },
    { id: "3", slug: "chiesa", name: "Chiesa", sellable: false, parent: "borgo", isUnit: true, units: 0 },
    { id: "4", slug: "piazza", name: "Piazza", sellable: false, parent: "borgo", isUnit: false, units: 0 },
    { id: "5", slug: "forte", name: "Forte", sellable: false, parent: "borgo", isUnit: false, units: 0 },
    { id: "6", slug: "lapide", name: "Lapide", sellable: false, parent: "borgo", isUnit: false, units: 0 },
    { id: "7", slug: "grazie", name: "Grazie", sellable: true, isUnit: true, units: 2 },
    { id: "8", slug: "santuario", name: "Santuario", sellable: false, parent: "grazie", isUnit: true, units: 0 },
  ];
  const files = [
    { ref: `${D}:torre`, stories: 2, verifiedStories: 2 },
    { ref: `${D}:chiesa`, stories: 1, verifiedStories: 1 },
    { ref: `${D}:piazza`, stories: 0, verifiedStories: 0 },
    { ref: `${D}:forte`, stories: 2, verifiedStories: 0 },
    { ref: `${D}:santuario`, stories: 1, verifiedStories: 1 },
  ];
  it("spiega per ogni sottoluogo perché si vende o non si vende da solo", () => {
    const rows = subPlaceSaleRows({ places, products: [product({ place: { id: "2", slug: "torre" } })] }, files, D);
    const state = Object.fromEntries(rows.map((r) => [r.slug, r.state]));
    expect(state).toEqual({
      torre: "on_sale", chiesa: "ready", piazza: "no_stories", forte: "in_review", lapide: "free", santuario: "ready",
    });
    // Santuario: il suo luogo (grazie) ha 2 contenuti; con uno solo si venderebbe il luogo.
    const solo = subPlaceSaleRows({ places: places.map((p) => (p.slug === "grazie" ? { ...p, units: 1 } : p)), products: [] }, files, D);
    expect(solo.find((r) => r.slug === "santuario")!.state).toBe("only_content");
    // Ordinati per luogo e nome; conteggi dal manifest.
    expect(rows.map((r) => r.slug)).toEqual(["chiesa", "forte", "lapide", "piazza", "torre", "santuario"]);
    expect(rows.find((r) => r.slug === "forte")).toMatchObject({ stories: 2, verified: 0, parentName: "Borgo" });
  });
  it("senza una pubblicazione con i file dei contenuti singoli: da ripubblicare", () => {
    expect(subPlaceSaleRows({ places, products: [] }, [], D).find((r) => r.slug === "piazza")!.state).toBe("not_published");
  });
});
