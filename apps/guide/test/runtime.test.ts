import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundle, type BundleContent } from "@guide/bundle";
import { destination } from "@guide/context-engine";
import { loadPacks } from "@guide/territory-pack";
import { beforeAll, describe, expect, it } from "vitest";
import { GuideRuntime, narrationBudgetS, type RuntimeEvent } from "../lib/runtime.ts";
import { simulateWalk } from "../lib/simulator.ts";

/**
 * Il runtime viene provato sul bundle compilato di un territorio di test:
 * nessun nome di territorio è scritto qui, si usa ciò che il bundle contiene.
 */
const here = dirname(fileURLToPath(import.meta.url));
let content: BundleContent;
const T0 = Date.UTC(2026, 4, 15, 9, 0, 0);
const MIN = 60_000;

beforeAll(() => {
  const { packs } = loadPacks(resolve(here, "../../../territories/_synthetic"));
  const dest = [...packs.values()].find((p) => p.manifest.kind === "destination")!;
  content = buildBundle(packs, { destination: dest.manifest.id, locale: "it", allowFictional: true }).content;
});

function walkPlan(runtime: GuideRuntime, startTime = T0) {
  const anchor = content.anchors[0]!;
  const stops = runtime.plan!.stops.map((s) => ({
    location: content.places.find((p) => p.ref === s.placeId)!.location,
    dwellS: 30,
  }));
  return simulateWalk(anchor.location, stops, { startTime });
}

function run(runtime: GuideRuntime, fixes: ReturnType<typeof walkPlan>, onEvent?: (e: RuntimeEvent) => RuntimeEvent[]) {
  const events: RuntimeEvent[] = [];
  for (const f of fixes) {
    for (const e of runtime.onFix(f)) {
      events.push(e);
      if (onEvent) events.push(...onEvent(e));
    }
  }
  return events;
}

describe("runtime della guida", () => {
  it("in modalità automatica racconta ogni tappa nell'ordine del piano, senza ripetere nulla", () => {
    const runtime = new GuideRuntime(content, "auto");
    const plan = runtime.startTour({ now: T0, start: content.anchors[0]!.location, budgetMin: 120 });
    expect(plan.status).toBe("ok");
    const events = run(runtime, walkPlan(runtime));

    const narrations = events.filter((e) => e.type === "narration");
    expect(narrations.map((n) => n.placeRef)).toEqual(
      plan.stops.map((s) => s.placeId).filter((p) => narrations.some((n) => n.placeRef === p)),
    );
    const texts = narrations.flatMap((n) => n.segments.filter((s) => s.kind === "unit").map((s) => s.text));
    expect(new Set(texts).size).toBe(texts.length);
    expect(events.at(-1)?.type).toBe("tour_complete");
  });

  it("in modalità su proposta chiede prima di raccontare", () => {
    const runtime = new GuideRuntime(content, "ask");
    runtime.startTour({ now: T0, start: content.anchors[0]!.location, budgetMin: 120 });
    const fixes = walkPlan(runtime);
    const events = run(runtime, fixes, (e) => (e.type === "proposal" ? runtime.acceptProposal(T0) : []));
    const proposals = events.filter((e) => e.type === "proposal");
    const narrations = events.filter((e) => e.type === "narration");
    expect(proposals.length).toBeGreaterThan(0);
    expect(narrations.length).toBe(proposals.length);
    // Nessun racconto prima della relativa proposta.
    for (const n of narrations) {
      const pIdx = events.findIndex((e) => e.type === "proposal" && e.placeRef === n.placeRef);
      expect(pIdx).toBeLessThan(events.indexOf(n));
    }
  });

  it("non propone di raccontare un luogo in cui non c'è nulla di nuovo da dire", () => {
    const runtime = new GuideRuntime(content, "ask");
    runtime.startTour({ now: T0, start: content.anchors[0]!.location, budgetMin: 120 });
    const events = run(runtime, walkPlan(runtime), (e) => (e.type === "proposal" ? runtime.acceptProposal(T0) : []));
    expect(events.some((e) => e.type === "nothing_new")).toBe(false);
    expect(events.at(-1)?.type).toBe("tour_complete");
  });

  it("se il visitatore rifiuta, non racconta", () => {
    const runtime = new GuideRuntime(content, "ask");
    runtime.startTour({ now: T0, start: content.anchors[0]!.location, budgetMin: 120 });
    const events = run(runtime, walkPlan(runtime), (e) => {
      if (e.type === "proposal") runtime.declineProposal();
      return [];
    });
    expect(events.some((e) => e.type === "narration")).toBe(false);
  });

  it("in modalità silenziosa segnala solo gli arrivi", () => {
    const runtime = new GuideRuntime(content, "silent");
    runtime.startTour({ now: T0, start: content.anchors[0]!.location, budgetMin: 120 });
    const events = run(runtime, walkPlan(runtime));
    expect(events.some((e) => e.type === "arrived")).toBe(true);
    expect(events.some((e) => e.type === "proposal" || e.type === "narration")).toBe(false);
  });

  it("non propone nulla a chi passa in battello", () => {
    const runtime = new GuideRuntime(content, "ask");
    runtime.startTour({ now: T0, start: content.anchors[0]!.location, budgetMin: 120 });
    const target = content.places.find((p) => p.geofences.some((g) => g.kind === "arrival"))!;
    const from = destination(target.location, 270, 600);
    const to = destination(target.location, 90, 600);
    const boat = simulateWalk(from, [{ location: to, dwellS: 0 }], { startTime: T0, speedMs: 9 });
    expect(run(runtime, boat).some((e) => e.type === "proposal")).toBe(false);
  });

  it("avvisa quando è ora di tornare all'ancora", () => {
    const runtime = new GuideRuntime(content, "auto");
    const anchor = content.anchors[0]!;
    runtime.startTour({ now: T0, start: anchor.location, anchor: { ref: anchor.ref, deadline: T0 + 45 * MIN } });
    const far = content.places.reduce((a, b) => (a.importance >= b.importance ? a : b));
    // Si resta fermi lontano dall'ancora fino a superare la scadenza.
    const fixes = simulateWalk(anchor.location, [{ location: far.location, dwellS: 50 * 60 }], { startTime: T0, stepS: 5 });
    const levels = run(runtime, fixes)
      .filter((e): e is Extract<RuntimeEvent, { type: "anchor" }> => e.type === "anchor")
      .map((e) => e.status.level);
    expect(levels).toEqual(["ok", "soon", "leave_now", "late"]);
  });

  it("il tempo di racconto per tappa resta tra 30 secondi e 3 minuti", () => {
    expect(narrationBudgetS(0.5)).toBe(30); // 18 s → minimo 30
    expect(narrationBudgetS(1)).toBe(36);
    expect(narrationBudgetS(10)).toBe(180); // 360 s → massimo 180
  });
});

describe("percorsi curati, invito alle domande, diagnostica", () => {
  it("con un percorso curato segue le tappe nell'ordine della redazione", () => {
    const route = content.routes[0]!;
    const runtime = new GuideRuntime(content, "auto");
    const plan = runtime.startTour({ now: T0, start: content.anchors[0]!.location, route: route.ref, budgetMin: 240 });
    const order = route.stops.map((s) => s.place);
    expect(plan.stops.map((s) => s.placeId)).toEqual(order.filter((p) => plan.stops.some((s) => s.placeId === p)));
    expect(plan.stops.map((s) => s.placeId)).toEqual(order);
  });

  it("dopo il racconto invita a fare domande solo se richiesto", () => {
    const runtime = new GuideRuntime(content, "auto");
    runtime.startTour({ now: T0, start: content.anchors[0]!.location, budgetMin: 120 });
    const place = runtime.plan!.stops[0]!.placeId;
    const plain = runtime.narrate(place).find((e) => e.type === "narration");
    expect(plain && plain.type === "narration" ? plain.segments.at(-1)!.kind : null).toBe("unit");

    const inviting = new GuideRuntime(content, "auto");
    inviting.inviteQuestions = true;
    inviting.startTour({ now: T0, start: content.anchors[0]!.location, budgetMin: 120 });
    const n = inviting.narrate(place).find((e) => e.type === "narration");
    expect(n && n.type === "narration" ? n.segments.at(-1)!.text : "").toMatch(/domand/);
  });

  it("l'istantanea di debug ordina i luoghi per distanza e mostra lo stato dei geofence", () => {
    const runtime = new GuideRuntime(content, "ask");
    runtime.startTour({ now: T0, start: content.anchors[0]!.location, budgetMin: 120 });
    const target = content.places[0]!;
    for (let i = 0; i < 15; i++) runtime.onFix({ location: target.location, accuracyM: 5, timestamp: T0 + i * 1000 });
    const snap = runtime.debugSnapshot();
    expect(snap.places[0]!.ref).toBe(target.ref);
    expect(snap.places[0]!.distanceM).toBe(0);
    expect(snap.places[0]!.fences.some((f) => f.phase === "inside")).toBe(true);
    expect(snap.places[0]!.coordinateStatus).toBe("field_verified");

    runtime.onFix({ location: target.location, accuracyM: 500, timestamp: T0 + 20_000 });
    expect(runtime.debugSnapshot().places[0]!.fences.every((f) => f.tooImprecise)).toBe(true);
  });
});

describe("percorso rigoroso e avanzamento manuale", () => {
  const route = () => content.routes[0]!;
  const offRoute = () => content.places.find((p) => !route().stops.some((s) => s.place === p.ref))!;
  const stay = (runtime: GuideRuntime, location: [number, number], from: number) => {
    const events: RuntimeEvent[] = [];
    for (let i = 0; i < 15; i++) events.push(...runtime.onFix({ location, accuracyM: 5, timestamp: from + i * 1000 }));
    return events;
  };
  const start = (mode: "auto" | "ask") => {
    const runtime = new GuideRuntime(content, mode);
    runtime.startTour({ now: T0, start: content.anchors[0]!.location, route: route().ref });
    return runtime;
  };

  it("nel percorso, un luogo fuori percorso non propone né racconta nulla", () => {
    const runtime = start("auto");
    const events = stay(runtime, offRoute().location, T0);
    expect(events.filter((e) => e.type === "narration" || e.type === "proposal")).toEqual([]);
    expect(runtime.currentPlaceRef).toBeNull();
  });

  it("in automatico racconta solo la tappa attesa; per una tappa successiva chiede", () => {
    const runtime = start("auto");
    const second = route().stops[1]!.place;
    const events = stay(runtime, content.places.find((p) => p.ref === second)!.location, T0);
    expect(events.some((e) => e.type === "narration")).toBe(false);
    expect(events.some((e) => e.type === "proposal" && e.placeRef === second)).toBe(true);
    expect(runtime.nextStop).toBe(route().stops[0]!.place); // nessuna tappa saltata in automatico
  });

  it("con 'Sono qui' racconta subito, anche senza GPS", () => {
    const runtime = start("ask");
    const first = route().stops[0]!.place;
    const events = runtime.arriveManually(first, T0);
    expect(events.some((e) => e.type === "narration" && e.placeRef === first)).toBe(true);
    expect(runtime.manualArrivals).toEqual([first]);
    expect(runtime.nextStop).toBe(route().stops[1]!.place);
  });

  it("'Salta' passa alla tappa successiva senza raccontare", () => {
    const runtime = start("ask");
    const first = route().stops[0]!.place;
    expect(runtime.skipStop(first).some((e) => e.type === "narration")).toBe(false);
    expect(runtime.skipped).toEqual([first]);
    expect(runtime.nextStop).toBe(route().stops[1]!.place);
  });

  it("lo stato salvato si ripristina dopo la riapertura", () => {
    const runtime = start("ask");
    runtime.arriveManually(route().stops[0]!.place, T0);
    runtime.skipStop(route().stops[1]!.place);
    const saved = JSON.parse(JSON.stringify(runtime.exportState()));

    const reopened = start("ask");
    reopened.restoreState(saved);
    expect(reopened.nextStop).toBe(runtime.nextStop);
    expect(reopened.memory).toEqual(runtime.memory);
    // Ciò che è già stato raccontato non si ripete.
    expect(reopened.arriveManually(route().stops[0]!.place, T0).some((e) => e.type === "narration")).toBe(false);
  });
});
