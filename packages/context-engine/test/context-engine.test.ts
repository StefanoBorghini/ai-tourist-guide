import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPacks } from "@guide/territory-pack";
import { beforeAll, describe, expect, it } from "vitest";
import {
  anchorStatus,
  bearingDeg,
  buildContextSnapshot,
  destination,
  distanceM,
  engineInputsFromPack,
  GeofenceTracker,
  MotionDetector,
  planTour,
  shouldReplan,
  toblerEstimator,
  type AnchorTarget,
  type Candidate,
  type EngineInputs,
  type GeofenceEvent,
} from "../src/index.ts";
import { startWalk, stay, walkTo } from "./simulate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_ROOT = resolve(here, "../../../territories/_synthetic");

let inputs: EngineInputs;
const place = (id: string) => inputs.places.find((p) => p.id === id)!;
const at = (id: string) => place(id).location;
const MIN = 60_000;

beforeAll(() => {
  const { packs, issues } = loadPacks(SYNTHETIC_ROOT);
  expect(issues).toEqual([]);
  inputs = engineInputsFromPack(packs.get("it.test.borgo-di-prova")!);
});

function anchorAt(now: number, minutes: number): AnchorTarget {
  const a = inputs.anchors[0]!;
  return { ...a, deadline: now + minutes * MIN };
}

// ----------------------------------------------------------------- geometria

describe("geometria", () => {
  it("calcola distanze e direzioni coerenti", () => {
    const origin = at("porta-del-borgo");
    const p = destination(origin, 90, 100);
    expect(distanceM(origin, p)).toBeCloseTo(100, 1);
    expect(bearingDeg(origin, p)).toBeCloseTo(90, 1);
  });

  it("la salita richiede più tempo della discesa", () => {
    const est = toblerEstimator();
    const up = est.seconds(place("chiesa-di-san-test"), place("torre-di-prova"));
    const down = est.seconds(place("torre-di-prova"), place("chiesa-di-san-test"));
    expect(up).toBeGreaterThan(down * 1.3);
  });
});

// ------------------------------------------------------------------ geofence

function run(tracker: GeofenceTracker, fixes: readonly import("../src/fix.ts").Fix[]): GeofenceEvent[] {
  return fixes.flatMap((f) => tracker.update(f));
}

describe("geofence", () => {
  it("riconosce l'arrivo dopo la permanenza minima, una sola volta", () => {
    const tracker = new GeofenceTracker(inputs.fences);
    const w = startWalk(inputs.anchors[0]!.location);
    walkTo(w, at("porta-del-borgo"), 1.3, { noiseM: 4 });
    stay(w, 30, { noiseM: 4 });
    const events = run(tracker, w.fixes).filter((e) => e.placeId === "porta-del-borgo");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("enter");
  });

  it("non scatta per un singolo fix anomalo dentro il raggio", () => {
    const tracker = new GeofenceTracker(inputs.fences);
    const far = destination(at("chiesa-di-san-test"), 180, 150);
    const w = startWalk(far);
    stay(w, 20);
    w.fixes.push({ location: at("chiesa-di-san-test"), accuracyM: 10, timestamp: w.time + 1000 });
    w.time += 1000;
    w.position = far;
    stay(w, 20);
    expect(run(tracker, w.fixes)).toEqual([]);
  });

  it("ignora le posizioni troppo imprecise", () => {
    const tracker = new GeofenceTracker(inputs.fences);
    const w = startWalk(at("chiesa-di-san-test"));
    stay(w, 60, { accuracyM: 80 });
    expect(run(tracker, w.fixes)).toEqual([]);
  });

  it("non oscilla quando il GPS balla sul bordo (isteresi)", () => {
    const tracker = new GeofenceTracker(inputs.fences);
    const center = at("chiesa-di-san-test");
    const w = startWalk(center);
    stay(w, 15);
    w.position = destination(center, 45, 33); // poco dentro il raggio di 35 m
    stay(w, 120, { noiseM: 8 });
    const events = run(tracker, w.fixes).filter((e) => e.placeId === "chiesa-di-san-test");
    expect(events.map((e) => e.type)).toEqual(["enter"]);
  });

  it("segnala l'uscita quando ci si allontana davvero", () => {
    const tracker = new GeofenceTracker(inputs.fences);
    const w = startWalk(at("chiesa-di-san-test"));
    stay(w, 15);
    walkTo(w, destination(at("chiesa-di-san-test"), 200, 120));
    stay(w, 15);
    const events = run(tracker, w.fixes).filter((e) => e.placeId === "chiesa-di-san-test");
    expect(events.map((e) => e.type)).toEqual(["enter", "exit"]);
  });

  it("conferma il punto panoramico solo se si guarda nella direzione giusta", () => {
    const viewpoint = inputs.fences.find((f) => f.kind === "viewpoint")!;
    const facing = new GeofenceTracker(inputs.fences);
    const away = new GeofenceTracker(inputs.fences);
    const look = (compassDeg: number) => stay(startWalk(viewpoint.center), 20, { compassDeg }).fixes;
    const seen = run(facing, look(25)).find((e) => e.fenceId === viewpoint.id)!;
    const notSeen = run(away, look(200)).find((e) => e.fenceId === viewpoint.id)!;
    expect(seen.facingConfirmed).toBe(true);
    expect(notSeen.facingConfirmed).toBe(false);
  });
});

// -------------------------------------------------------------------- moto

describe("movimento", () => {
  const classify = (fixes: readonly import("../src/fix.ts").Fix[]) => {
    const d = new MotionDetector();
    let last = d.current();
    for (const f of fixes) last = d.update(f);
    return last;
  };

  it("riconosce chi è fermo nonostante il rumore del GPS", () => {
    expect(classify(stay(startWalk(at("belvedere")), 30, { noiseM: 5 }).fixes)).toBe("stationary");
  });

  it("riconosce chi cammina", () => {
    const w = startWalk(at("porta-del-borgo"));
    walkTo(w, destination(at("porta-del-borgo"), 90, 60), 1.3, { noiseM: 3 });
    expect(classify(w.fixes)).toBe("walking");
  });

  it("riconosce chi è su un battello", () => {
    const w = startWalk(at("porta-del-borgo"));
    walkTo(w, destination(at("porta-del-borgo"), 270, 400), 9);
    expect(classify(w.fixes)).toBe("vehicle");
  });
});

// --------------------------------------------------------------- pianificatore

describe("pianificatore", () => {
  const now = Date.UTC(2026, 4, 15, 10, 0, 0);
  const start = () => ({ location: inputs.anchors[0]!.location });

  it("con molto tempo include tutti i luoghi e rientra all'ancora", () => {
    const plan = planTour({ now, start: start(), candidates: inputs.places, anchor: anchorAt(now, 180) });
    expect(plan.status).toBe("ok");
    expect(plan.stops.map((s) => s.placeId).sort()).toEqual(inputs.places.map((p) => p.id).sort());
    expect(plan.endAt).toBeLessThanOrEqual(plan.availableUntil);
    expect(plan.returnWalkS).toBeGreaterThan(0);
  });

  it("con poco tempo sceglie i luoghi più importanti e rispetta la scadenza", () => {
    const anchor = anchorAt(now, 30);
    const plan = planTour({ now, start: start(), candidates: inputs.places, anchor });
    expect(plan.status).toBe("ok");
    expect(plan.endAt).toBeLessThanOrEqual(anchor.deadline - anchor.safetyMarginMin * MIN);
    expect(plan.stops.length).toBeLessThan(inputs.places.length);
    expect(plan.stops.map((s) => s.placeId)).toContain("chiesa-di-san-test");
    expect(plan.stops.map((s) => s.placeId)).not.toContain("carrugio-centrale");
  });

  it("se non c'è tempo nemmeno per rientrare lo segnala", () => {
    const plan = planTour({ now, start: { location: at("belvedere") }, candidates: inputs.places, anchor: anchorAt(now, 12) });
    expect(plan.status).toBe("no_time");
    expect(plan.stops).toEqual([]);
  });

  it("evita le scale se richiesto", () => {
    const plan = planTour({ now, start: start(), candidates: inputs.places, budgetMin: 180, avoidStairs: true });
    expect(plan.stops.map((s) => s.placeId)).not.toContain("torre-di-prova");
  });

  it("esclude i luoghi già visitati", () => {
    const plan = planTour({
      now,
      start: start(),
      candidates: inputs.places,
      budgetMin: 180,
      visited: new Set(["chiesa-di-san-test"]),
    });
    expect(plan.stops.map((s) => s.placeId)).not.toContain("chiesa-di-san-test");
  });

  it("a parità di importanza, l'interesse decide quale luogo vedere", () => {
    // Due luoghi equivalenti a 100 m in direzioni opposte: c'è tempo per uno solo.
    const origin = at("porta-del-borgo");
    const candidates = [
      { id: "a-chiesa", location: destination(origin, 0, 100), importance: 3, dwellMin: 10, tags: ["church"] },
      { id: "b-panorama", location: destination(origin, 180, 100), importance: 3, dwellMin: 10, tags: ["viewpoint"] },
    ];
    const base = { now, start: { location: origin }, candidates, budgetMin: 15 };
    expect(planTour(base).stops).toHaveLength(1);
    expect(planTour({ ...base, interests: ["viewpoint"] }).stops.map((s) => s.placeId)).toEqual(["b-panorama"]);
    expect(planTour({ ...base, interests: ["church"] }).stops.map((s) => s.placeId)).toEqual(["a-chiesa"]);
  });

  it("l'interesse non scavalca un luogo molto più importante", () => {
    const plan = planTour({ now, start: start(), candidates: inputs.places, budgetMin: 14, interests: ["viewpoint"] });
    expect(plan.stops.map((s) => s.placeId)).toEqual(["chiesa-di-san-test"]);
  });

  it("trova la combinazione migliore anche dove il metodo greedy sbaglia", () => {
    // Con 20 minuti utili il greedy sceglierebbe carrugio + porta (valore 20);
    // la sola chiesa vale di più (25) e ci sta.
    const anchor = anchorAt(now, 30);
    const plan = planTour({ now, start: start(), candidates: inputs.places, anchor });
    expect(plan.value).toBeGreaterThanOrEqual(25);
  });

  it("a parità di durata parte dalla tappa più vicina", () => {
    const plan = planTour({ now, start: start(), candidates: inputs.places, anchor: anchorAt(now, 60) });
    const nearest = [...plan.stops].sort(
      (a, b) => distanceM(start().location, at(a.placeId)) - distanceM(start().location, at(b.placeId)),
    )[0]!;
    expect(plan.stops[0]!.placeId).toBe(nearest.placeId);
  });

  it("produce orari coerenti tra tappe successive", () => {
    const plan = planTour({ now, start: start(), candidates: inputs.places, budgetMin: 120 });
    let t = now;
    for (const s of plan.stops) {
      expect(s.arriveAt).toBeGreaterThanOrEqual(t);
      expect(s.leaveAt).toBeGreaterThan(s.arriveAt);
      t = s.leaveAt;
    }
  });

  it("resta rapido con molti candidati", () => {
    const origin = at("porta-del-borgo");
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `luogo-${String(i).padStart(2, "0")}`,
      location: destination(origin, (i * 137) % 360, 50 + ((i * 53) % 600)),
      importance: 1 + (i % 5),
      dwellMin: 3 + (i % 8),
    }));
    const t0 = performance.now();
    const plan = planTour({ now, start: { location: origin }, candidates: many, budgetMin: 90 });
    const elapsed = performance.now() - t0;
    expect(plan.status).toBe("ok");
    expect(plan.endAt).toBeLessThanOrEqual(plan.availableUntil);
    expect(elapsed).toBeLessThan(1500);
  });

  it("richiede un budget o un'ancora", () => {
    expect(() => planTour({ now, start: start(), candidates: inputs.places })).toThrow();
  });
});

// ------------------------------------------------------------------ monitor

describe("monitor del tempo", () => {
  const now = Date.UTC(2026, 4, 15, 16, 0, 0);
  const levelAt = (minutesToDeadline: number) =>
    anchorStatus({ now, position: { location: at("belvedere") }, anchor: anchorAt(now, minutesToDeadline) }).level;

  it("passa da ok ad avviso, a partenza immediata, a ritardo", () => {
    expect(levelAt(60)).toBe("ok");
    expect(levelAt(22)).toBe("soon");
    expect(levelAt(10)).toBe("leave_now");
    expect(levelAt(2)).toBe("late");
  });

  it("chiede di ripianificare quando si è in ritardo sulla tappa successiva", () => {
    const plan = planTour({ now, start: { location: at("porta-del-borgo") }, candidates: inputs.places, budgetMin: 90 });
    const first = plan.stops[0]!;
    expect(shouldReplan(plan, first.arriveAt + 2 * MIN, 0)).toBe(false);
    expect(shouldReplan(plan, first.arriveAt + 8 * MIN, 0)).toBe(true);
  });
});

// ---------------------------------------------------------------- istantanea

describe("istantanea del contesto", () => {
  it("riunisce luogo corrente, vicini, tappa successiva e ancora", () => {
    const now = Date.UTC(2026, 4, 15, 11, 0, 0);
    const tracker = new GeofenceTracker(inputs.fences);
    const motion = new MotionDetector();
    const w = startWalk(at("chiesa-di-san-test"), now);
    stay(w, 20, { compassDeg: 30, noiseM: 3 });
    for (const f of w.fixes) {
      tracker.update(f);
      motion.update(f);
    }
    const plan = planTour({
      now: w.time,
      start: { location: at("chiesa-di-san-test") },
      candidates: inputs.places,
      budgetMin: 60,
      visited: new Set(["porta-del-borgo", "chiesa-di-san-test"]),
    });
    const snapshot = buildContextSnapshot({
      now: w.time,
      fix: w.fixes.at(-1)!,
      motion: motion.current(),
      places: inputs.places,
      fences: inputs.fences,
      activeFenceIds: tracker.activeFenceIds(),
      visited: new Set(["porta-del-borgo"]),
      plan,
      nextStopIndex: 0,
      anchor: anchorAt(now, 120),
    });

    expect(snapshot.currentPlaceId).toBe("chiesa-di-san-test");
    expect(snapshot.motion).toBe("stationary");
    expect(snapshot.inViewPlaceIds).toContain("torre-di-prova");
    expect(snapshot.nearby.map((n) => n.placeId)).toContain("torre-di-prova");
    expect(snapshot.nearby.every((n) => n.direction !== null)).toBe(true);
    expect(snapshot.nextStop?.placeId).toBe(plan.stops[0]!.placeId);
    expect(snapshot.anchor?.level).toBe("ok");
    // L'istantanea non contiene coordinate del visitatore.
    expect(JSON.stringify(snapshot)).not.toMatch(/location|lng|lat/);
  });
});

describe("percorsi curati e luoghi non raggiungibili a piedi", () => {
  const base = { now: 0, start: { location: [0, 0] as [number, number] }, budgetMin: 60 };
  const c = (id: string, lng: number, extra: Partial<Candidate> = {}): Candidate => ({ id, location: [lng, 0], importance: 3, dwellMin: 5, ...extra });

  it("non propone mai luoghi non raggiungibili a piedi", () => {
    const plan = planTour({ ...base, candidates: [c("isola", 0.001, { walkable: false, importance: 5 }), c("chiesa", 0.002)] });
    expect(plan.stops.map((s) => s.placeId)).toEqual(["chiesa"]);
  });

  it("con fixedOrder mantiene l'ordine del percorso", () => {
    const plan = planTour({ ...base, fixedOrder: true, candidates: [c("lontano", 0.004), c("vicino", 0.001), c("medio", 0.002)] });
    expect(plan.stops.map((s) => s.placeId)).toEqual(["lontano", "vicino", "medio"]);
  });

  it("con fixedOrder salta le tappe che non stanno nel tempo", () => {
    const plan = planTour({ ...base, budgetMin: 12, fixedOrder: true, candidates: [c("a", 0.001), c("b", 0.0012), c("c", 0.0014)] });
    expect(plan.stops.length).toBeLessThan(3);
    expect(plan.stops.map((s) => s.placeId)).toEqual(["a", "b", "c"].slice(0, plan.stops.length));
  });
});
