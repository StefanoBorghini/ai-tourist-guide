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
});
