import { describe, expect, it } from "vitest";
import { isPackWithin, resolveRef } from "../src/ids.ts";

describe("resolveRef", () => {
  it("risolve uno slug locale nel pack corrente", () => {
    expect(resolveRef("chiesa-madre", "it.regione.paese")).toEqual({
      packId: "it.regione.paese",
      slug: "chiesa-madre",
    });
  });

  it("risolve un riferimento completo a un altro pack", () => {
    expect(resolveRef("it.regione:repubblica", "it.regione.paese")).toEqual({
      packId: "it.regione",
      slug: "repubblica",
    });
  });

  it("rifiuta riferimenti malformati", () => {
    expect(resolveRef("Chiesa Madre", "it.test")).toBeNull();
    expect(resolveRef("it.test:", "it.test")).toBeNull();
    expect(resolveRef(":slug", "it.test")).toBeNull();
  });
});

describe("isPackWithin", () => {
  it("riconosce i pack discendenti", () => {
    expect(isPackWithin("it.regione.paese", "it.regione")).toBe(true);
    expect(isPackWithin("it.regione", "it.regione")).toBe(true);
    expect(isPackWithin("it.regionexyz", "it.regione")).toBe(false);
  });
});
