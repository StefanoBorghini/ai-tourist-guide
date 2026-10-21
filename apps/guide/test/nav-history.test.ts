import { describe, expect, it } from "vitest";
import { asNavState, HOME, initialStack, LIST, navStateOf, navStep, navUrl, readNavUrl, type NavState } from "../lib/nav-history.ts";

const visit = (d = "it.liguria.sp.portovenere", tab: NavState["tab"] = "esplora"): NavState => ({ depth: 2, tab, d });

describe("stato della cronologia da ciò che si vede", () => {
  it("Home 0, schede 1, visita 2", () => {
    expect(navStateOf({ tab: "home", inVisit: false, destination: "x" })).toEqual(HOME);
    expect(navStateOf({ tab: "esplora", inVisit: false, destination: "x" })).toEqual(LIST);
    expect(navStateOf({ tab: "profilo", inVisit: false, destination: "x" })).toEqual({ depth: 1, tab: "profilo", d: null });
    expect(navStateOf({ tab: "percorsi", inVisit: false, destination: "x" })).toEqual({ depth: 1, tab: "percorsi", d: "x" });
    expect(navStateOf({ tab: "esplora", inVisit: true, destination: "x" })).toEqual(visit("x"));
    expect(navStateOf({ tab: "percorsi", inVisit: true, destination: "x" })).toEqual(visit("x", "percorsi"));
  });
});

describe("passaggi nella cronologia (back del telefono, niente cicli)", () => {
  it("si scende con il back, si sale aggiungendo, allo stesso livello si sostituisce", () => {
    expect(navStep(HOME, LIST)).toEqual({ kind: "push", states: [LIST] });
    expect(navStep(LIST, visit())).toEqual({ kind: "push", states: [visit()] });
    // Dalla Home direttamente in visita: sotto resta l'elenco delle destinazioni.
    expect(navStep(HOME, visit())).toEqual({ kind: "push", states: [LIST, visit()] });
    expect(navStep(visit(), LIST)).toEqual({ kind: "back", steps: 1 });
    expect(navStep(visit(), HOME)).toEqual({ kind: "back", steps: 2 });
    expect(navStep(LIST, { depth: 1, tab: "profilo", d: null })).toEqual({ kind: "replace" });
    expect(navStep(visit("a"), visit("a", "percorsi"))).toEqual({ kind: "replace" });
    expect(navStep(LIST, LIST)).toEqual({ kind: "none" });
    expect(navStep(null, LIST)).toEqual({ kind: "replace" });
  });

  it("prima apertura da un link: Home sotto, poi l'elenco, poi la visita", () => {
    expect(initialStack(visit())).toEqual([HOME, LIST, visit()]);
    expect(initialStack({ depth: 1, tab: "profilo", d: null })).toEqual([HOME, { depth: 1, tab: "profilo", d: null }]);
    expect(initialStack(HOME)).toEqual([HOME]);
  });
});

describe("indirizzo", () => {
  it("solo v e d; gli altri parametri restano", () => {
    expect(navUrl(visit("a.b"), "?debug=1")).toBe("?debug=1&v=esplora&d=a.b");
    expect(navUrl(HOME, "?v=profilo&d=a")).toBe("");
    expect(navUrl(LIST, "")).toBe("?v=esplora");
  });

  it("valori sconosciuti o strani ignorati", () => {
    expect(readNavUrl("?v=esplora&d=it.liguria.sp.portovenere")).toEqual({ v: "esplora", d: "it.liguria.sp.portovenere" });
    expect(readNavUrl("?v=admin&d=../x")).toEqual({ v: null, d: null });
    expect(readNavUrl("?v=home")).toEqual({ v: null, d: null });
    expect(readNavUrl("?d=<script>")).toEqual({ v: null, d: null });
  });

  it("stato letto dalla cronologia: solo forme valide", () => {
    expect(asNavState(visit())).toEqual(visit());
    expect(asNavState({ depth: 2, tab: "esplora", d: null })).toBeNull();
    expect(asNavState({ depth: 0, tab: "profilo", d: null })).toBeNull();
    expect(asNavState({ depth: 3, tab: "esplora", d: null })).toBeNull();
    expect(asNavState("x")).toBeNull();
    expect(asNavState(null)).toBeNull();
  });
});
