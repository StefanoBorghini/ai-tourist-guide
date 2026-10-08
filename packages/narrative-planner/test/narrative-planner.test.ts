import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPacks } from "@guide/territory-pack";
import { beforeAll, describe, expect, it } from "vitest";
import {
  adjustInterest,
  applyStopPlan,
  buildLibrary,
  emptyMemory,
  planStop,
  rememberAssertions,
  renderBridgeTemplate,
  type NarrativeLibrary,
  type PlanItem,
  type StopPlan,
  type TourMemory,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_ROOT = resolve(here, "../../../territories/_synthetic");
const D = "it.test.borgo-di-prova";
const ref = (slug: string) => `${D}:${slug}`;
const area = (slug: string) => `it.test:${slug}`;

let library: NarrativeLibrary;

beforeAll(() => {
  const { packs, issues } = loadPacks(SYNTHETIC_ROOT);
  expect(issues).toEqual([]);
  library = buildLibrary(D, packs);
});

const units = (plan: StopPlan) =>
  plan.items.filter((i): i is Extract<PlanItem, { kind: "unit" }> => i.kind === "unit").map((i) => i.unitRef);
const kinds = (plan: StopPlan) => plan.items.map((i) => i.kind);

function stop(memory: TourMemory, place: string, timeBudgetS = 90, nextPlace: string | null = null, locale: "it" | "en" = "it") {
  return planStop({ library, memory, placeRef: ref(place), locale, timeBudgetS, nextPlaceRef: nextPlace ? ref(nextPlace) : null });
}

describe("libreria narrativa", () => {
  it("include le unità della destinazione e delle sue dipendenze", () => {
    expect(library.units.has(ref("porta-apertura-it"))).toBe(true);
    expect(library.units.has(area("repubblica-introduzione-it"))).toBe(true);
    expect(library.introducers.get(`it|${area("difese-costiere")}`)?.map((u) => u.ref)).toEqual([
      area("repubblica-introduzione-it"),
    ]);
  });
});

describe("prima tappa", () => {
  it("introduce prima i concetti necessari, poi racconta il luogo", () => {
    const plan = stop(emptyMemory(), "porta-del-borgo");
    expect(units(plan)).toEqual([area("repubblica-introduzione-it"), ref("porta-apertura-it")]);
    expect(plan.items[0]).toMatchObject({ kind: "unit", role: "prerequisite" });
  });

  it("lascia un gancio verso la tappa successiva", () => {
    const plan = stop(emptyMemory(), "porta-del-borgo", 90, "torre-di-prova");
    expect(plan.items.at(-1)).toMatchObject({ kind: "hook", target: ref("torre-di-prova") });
  });

  it("non racconta un'unità se non c'è tempo anche per i suoi prerequisiti", () => {
    const plan = stop(emptyMemory(), "porta-del-borgo", 25);
    expect(plan.items).toEqual([]);
    expect(plan.skipped).toContainEqual({ unitRef: ref("porta-apertura-it"), reason: "budget" });
  });

  it("rispetta sempre il tempo disponibile", () => {
    for (const budget of [10, 20, 30, 45, 60, 120]) {
      for (const place of ["porta-del-borgo", "chiesa-di-san-test", "torre-di-prova", "belvedere"]) {
        expect(stop(emptyMemory(), place, budget).totalS).toBeLessThanOrEqual(budget);
      }
    }
  });
});

describe("racconto progressivo", () => {
  it("alla torre riprende la promessa e richiama ciò che si è detto alla porta", () => {
    const atGate = stop(emptyMemory(), "porta-del-borgo", 90, "torre-di-prova");
    const memory = applyStopPlan(emptyMemory(), atGate, library);
    expect(memory.introducedConcepts[area("difese-costiere")]).toEqual({ atPlace: ref("porta-del-borgo") });
    expect(memory.openThreads.map((t) => t.target)).toEqual([ref("torre-di-prova")]);

    const atTower = stop(memory, "torre-di-prova");
    expect(kinds(atTower)).toEqual(["thread", "callback", "unit"]);
    expect(units(atTower)).toEqual([ref("torre-dettaglio-it")]);
    expect(atTower.items[1]).toMatchObject({ kind: "callback", fromPlace: ref("porta-del-borgo") });

    const after = applyStopPlan(memory, atTower, library);
    expect(after.openThreads).toEqual([]);
  });

  it("non ripete ciò che è già stato ascoltato", () => {
    const first = stop(emptyMemory(), "chiesa-di-san-test");
    const memory = applyStopPlan(emptyMemory(), first, library);
    const again = stop(memory, "chiesa-di-san-test");
    expect(again.items).toEqual([]);
    expect(again.skipped).toContainEqual({ unitRef: ref("chiesa-datazione-it"), reason: "heard" });
  });

  it("salta un'unità i cui fatti sono già stati raccontati dall'AI in una risposta", () => {
    const memory = rememberAssertions(emptyMemory(), [ref("porta-funzione"), ref("porta-larghezza")]);
    const plan = stop(memory, "porta-del-borgo");
    expect(units(plan)).not.toContain(ref("porta-apertura-it"));
    expect(plan.skipped).toContainEqual({ unitRef: ref("porta-apertura-it"), reason: "already_told" });
  });
});

describe("personalizzazione", () => {
  it("con il tempo per una sola unità, sceglie secondo gli interessi", () => {
    const neutral = stop(emptyMemory(), "belvedere", 18);
    expect(units(neutral)).toEqual([ref("belvedere-leggenda-it")]);

    let curious = emptyMemory();
    for (let i = 0; i < 4; i++) curious = adjustInterest(curious, "curiosity", "more");
    expect(curious.interests.curiosity).toBe(1);
    expect(units(stop(curious, "belvedere", 18))).toEqual([ref("belvedere-ada-it")]);
  });

  it("usa le unità generali quando non ce ne sono per il pubblico richiesto", () => {
    const plan = planStop({ library, memory: emptyMemory(), placeRef: ref("chiesa-di-san-test"), locale: "it", audience: "kids", timeBudgetS: 60 });
    expect(units(plan)).toEqual([ref("chiesa-datazione-it")]);
  });

  it("racconta nella lingua del visitatore", () => {
    const plan = stop(emptyMemory(), "porta-del-borgo", 90, null, "en");
    expect(units(plan)).toEqual([area("repubblica-introduzione-en"), ref("porta-apertura-en")]);
  });
});

describe("raccordi a modello", () => {
  it("rendono richiami e promesse senza aggiungere fatti", () => {
    const callback = { kind: "callback", conceptRef: area("repubblica-immaginaria"), fromPlace: ref("porta-del-borgo"), durationS: 4 } as const;
    expect(renderBridgeTemplate(callback, "it", library)).toBe("Ti ricordi? A Porta del Borgo abbiamo parlato di Repubblica Immaginaria.");
    expect(renderBridgeTemplate(callback, "en", library)).toBe("Remember? At Village Gate we talked about Imaginary Republic.");
    const thread = { kind: "thread", fromPlace: ref("porta-del-borgo"), promise: "…", durationS: 4 } as const;
    expect(renderBridgeTemplate(thread, "it", library)).toBe("Come ti avevo promesso a Porta del Borgo, eccoci qui.");
  });
});

describe("tour completo", () => {
  it("lungo il percorso non ripete nulla e spiega ogni concetto prima di darlo per scontato", () => {
    const route = ["porta-del-borgo", "chiesa-di-san-test", "torre-di-prova", "belvedere"];
    let memory = emptyMemory();
    const heard: string[] = [];
    for (const [i, place] of route.entries()) {
      const plan = stop(memory, place, 90, route[i + 1] ?? null);
      // Concetti noti: quelli della memoria più quelli introdotti dalle unità già ascoltate in questa tappa.
      const known = new Set(Object.keys(memory.introducedConcepts));
      for (const unitRef of units(plan)) {
        const unit = library.units.get(unitRef)!;
        for (const concept of unit.requires) expect(known.has(concept), `${unitRef} richiede ${concept}`).toBe(true);
        for (const concept of unit.introduces) known.add(concept);
        heard.push(unitRef);
      }
      memory = applyStopPlan(memory, plan, library);
    }
    expect(new Set(heard).size).toBe(heard.length);
    expect(memory.visitedPlaces).toEqual(route.map(ref));
    // Tutte le unità italiane del borgo sono state raccontate.
    const villageIt = [...library.units.values()].filter((u) => u.ref.startsWith(`${D}:`) && u.locale === "it").map((u) => u.ref);
    expect(villageIt.every((r) => heard.includes(r))).toBe(true);
    expect(memory.openThreads).toEqual([]);
  });
});
