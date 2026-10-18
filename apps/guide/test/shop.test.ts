import { mergePremium, type BundleContent, type PremiumPart } from "@guide/bundle/client";
import { describe, expect, it } from "vitest";
import { formatPrice, lockedPlaceRefs, offersFor, type CatalogItem } from "../lib/shop";

const item = (over: Partial<CatalogItem> & Pick<CatalogItem, "id" | "kind">): CatalogItem => ({
  labels: { it: { name: `Prodotto ${over.id}` }, en: { name: `Product ${over.id}` } },
  price: { amount: 499, currency: "EUR" },
  available: true,
  ...over,
});

const locked = {
  explore: true,
  routes: [
    { ref: "it.test.borgo:giro-breve", name: "Giro breve", durationMin: 45 },
    { ref: "it.test.borgo:giro-lungo", name: "Giro lungo", durationMin: 90 },
  ],
};

describe("vendita nell'app", () => {
  it("abbina esplorazione, percorso singolo e pacchetto (il più economico)", () => {
    const o = offersFor(locked, [
      item({ id: "e", kind: "explore", price: { amount: 999, currency: "EUR" } }),
      item({ id: "r", kind: "route", route: "giro-breve", price: { amount: 299, currency: "EUR" } }),
      item({ id: "b1", kind: "bundle", routes: ["giro-breve", "giro-lungo"], price: { amount: 799, currency: "EUR" } }),
      item({ id: "b2", kind: "bundle", routes: ["giro-lungo"], price: { amount: 599, currency: "EUR" } }),
    ], "en");
    expect(o.explore).toEqual({ productId: "e", name: "Product e", amount: 999, bundle: false });
    expect(o.routes.get("it.test.borgo:giro-breve")?.productId).toBe("r");
    expect(o.routes.get("it.test.borgo:giro-lungo")).toEqual({ productId: "b2", name: "Product b2", amount: 599, bundle: true });
  });

  it("niente offerta per ciò che non è acquistabile o non è bloccato", () => {
    const o = offersFor({ explore: false, routes: locked.routes }, [
      item({ id: "e", kind: "explore" }),
      item({ id: "r", kind: "route", route: "giro-breve", available: false }),
    ], "it");
    expect(o.explore).toBeNull();
    expect(o.routes.size).toBe(0);
    expect(offersFor(undefined, [item({ id: "e", kind: "explore" })], "it").explore).toBeNull();
  });

  it("singoli luoghi: offerta solo per i luoghi bloccati della destinazione, e solo con l'esplorazione a pagamento", () => {
    const items = [
      item({ id: "e", kind: "explore" }),
      item({ id: "p1", kind: "place", place: "torre", price: { amount: 50, currency: "EUR" } }),
      item({ id: "p2", kind: "place", place: "chiesa", available: false }),
    ];
    const places = { destination: "it.test.borgo", refs: ["it.test.borgo:torre", "it.test.borgo:chiesa", "altro.pack:torre"] };
    const o = offersFor(locked, items, "it", places);
    expect([...o.places.keys()]).toEqual(["it.test.borgo:torre"]);
    expect(o.places.get("it.test.borgo:torre")).toEqual({ productId: "p1", name: "Prodotto p1", amount: 50, bundle: false });
    expect(offersFor({ explore: false, routes: [] }, items, "it", places).places.size).toBe(0);
    expect(offersFor(locked, items, "it").places.size).toBe(0);
  });

  it("luoghi introduttivi o senza racconti: gratuiti, anche se non hanno racconti nel bundle pubblico", () => {
    const content = {
      locked: { explore: true, routes: [], places: ["b:torre"] },
      places: [{ ref: "b:porta" }, { ref: "b:torre" }, { ref: "b:vuoto" }],
      units: [],
    } as unknown as BundleContent;
    expect([...lockedPlaceRefs(content)]).toEqual(["b:torre"]);
  });

  it("luogo comprato da solo: si sblocca quel luogo, gli altri restano a pagamento", () => {
    const content = {
      locked: { explore: true, routes: [] },
      places: [{ ref: "b:porta" }, { ref: "b:torre" }, { ref: "b:chiesa" }],
      units: [{ ref: "b:porta-apertura", anchor: "b:porta" }],
      assertions: [], sources: [], routes: [],
    } as unknown as BundleContent;
    const place = {
      kind: "place", ref: "b:torre", units: [{ ref: "b:torre-racconto", anchor: "b:torre" }], assertions: [], sources: [], routes: [],
    } as unknown as PremiumPart;
    const merged = mergePremium(content, [place]);
    expect([...lockedPlaceRefs(merged)]).toEqual(["b:chiesa"]);
    expect(merged.locked?.explore).toBe(true);
  });

  it("prezzo nella lingua dell'app", () => {
    expect(formatPrice(499, "it").replace(/\s/g, " ")).toBe("4,99 €");
    expect(formatPrice(499, "en")).toBe("€4.99");
  });

  it("luoghi a pagamento: con l'esplorazione a pagamento, quelli senza racconti pubblici", () => {
    const places = [{ ref: "b:porta" }, { ref: "b:torre" }, { ref: "b:chiesa" }] as never;
    const units = [{ anchor: "b:porta" }] as never;
    expect([...lockedPlaceRefs({ locked: { explore: true, routes: [] }, places, units })]).toEqual(["b:torre", "b:chiesa"]);
    expect(lockedPlaceRefs({ locked: { explore: false, routes: [] }, places, units }).size).toBe(0);
    expect(lockedPlaceRefs({ places, units } as never).size).toBe(0);
  });

  it("percorso acquistato: i suoi luoghi si sbloccano anche nell'esplorazione libera", () => {
    const content = {
      locked: { explore: true, routes: [{ ref: "b:giro", name: "Giro", durationMin: 30 }] },
      places: [{ ref: "b:porta" }, { ref: "b:torre" }, { ref: "b:chiesa" }],
      units: [{ ref: "b:porta-apertura", anchor: "b:porta" }],
      assertions: [], sources: [], routes: [],
    } as unknown as BundleContent;
    const route = {
      kind: "route", ref: "b:giro", units: [{ ref: "b:torre-racconto", anchor: "b:torre" }], assertions: [], sources: [],
      routes: [{ ref: "b:giro", name: "Giro", durationMin: 30, stops: [{ place: "b:torre" }] }],
    } as unknown as PremiumPart;
    expect([...lockedPlaceRefs(content)]).toEqual(["b:torre", "b:chiesa"]);
    const merged = mergePremium(content, [route]);
    expect([...lockedPlaceRefs(merged)]).toEqual(["b:chiesa"]);
    expect(merged.locked?.routes).toEqual([]);
  });
});
