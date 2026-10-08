import {
  anchorStatus,
  GeofenceTracker,
  MotionDetector,
  planTour,
  type AnchorStatus,
  type AnchorTarget,
  type Fix,
  type Motion,
  type TourPlan,
} from "@guide/context-engine";
import { engineInputsFromBundle, libraryFromBundle, type BundleContent } from "@guide/bundle/client";
import {
  applyStopPlan,
  emptyMemory,
  planStop,
  renderBridgeTemplate,
  type NarrativeLibrary,
  type StopPlan,
  type TourMemory,
} from "@guide/narrative-planner";
import type { Audience } from "@guide/domain";

/**
 * Runtime della guida: collega motore di contesto e pianificatore narrativo.
 *
 * Riceve posizioni (GPS reale o simulato) e restituisce eventi: arrivo in un luogo,
 * proposta di racconto, racconto da riprodurre, avvisi di tempo, fine del tour.
 * Non sa nulla di interfaccia né di audio: è logica pura, testata senza browser.
 */

export type GuideMode = "auto" | "ask" | "silent";

export interface NarrationSegment {
  id: string;
  kind: "unit" | "bridge";
  text: string;
  placeRef: string;
}

export type RuntimeEvent =
  | { type: "arrived"; placeRef: string; name: string }
  | { type: "proposal"; placeRef: string; name: string }
  | { type: "narration"; placeRef: string; name: string; segments: NarrationSegment[] }
  | { type: "nothing_new"; placeRef: string; name: string }
  | { type: "anchor"; status: AnchorStatus }
  | { type: "tour_complete" };

export interface TourOptions {
  now: number;
  start: Fix["location"];
  budgetMin?: number;
  /** Ancora (riferimento completo) e ora entro cui esserci. */
  anchor?: { ref: string; deadline: number };
  avoidStairs?: boolean;
  interests?: string[];
}

/**
 * Area di arrivo predefinita per i luoghi che non ne hanno una nel pack:
 * ogni tappa di un tour deve poter essere riconosciuta.
 */
export const DEFAULT_ARRIVAL_RADIUS_M = 25;

/** Tempo di racconto per tappa: una parte della sosta prevista, tra 30 secondi e 3 minuti. */
export function narrationBudgetS(dwellMin: number): number {
  return Math.round(Math.min(180, Math.max(30, dwellMin * 60 * 0.6)));
}

export class GuideRuntime {
  readonly library: NarrativeLibrary;
  private readonly places: ReturnType<typeof engineInputsFromBundle>["places"];
  private readonly anchors: ReturnType<typeof engineInputsFromBundle>["anchors"];
  private readonly tracker: GeofenceTracker;
  private readonly motionDetector = new MotionDetector();
  private readonly names: Map<string, string>;

  memory: TourMemory = emptyMemory();
  plan: TourPlan | null = null;
  anchor: AnchorTarget | null = null;
  motion: Motion = "unknown";
  currentPlaceRef: string | null = null;
  pendingProposal: string | null = null;
  lastAnchorStatus: AnchorStatus | null = null;
  lastFix: Fix | null = null;
  private narratedHere = new Set<string>();
  private segmentCounter = 0;

  constructor(
    readonly content: BundleContent,
    public mode: GuideMode = "ask",
    public audience: Audience = "general",
  ) {
    const inputs = engineInputsFromBundle(content);
    this.places = inputs.places;
    this.anchors = inputs.anchors;
    const withArrival = new Set(inputs.fences.filter((f) => f.kind === "arrival").map((f) => f.placeId));
    const defaults = inputs.places
      .filter((p) => !withArrival.has(p.id))
      .map((p) => ({
        id: `${p.id}#arrival#default`,
        placeId: p.id,
        kind: "arrival" as const,
        center: p.location,
        radiusM: DEFAULT_ARRIVAL_RADIUS_M,
        minDwellS: 8,
        maxAccuracyM: 35,
      }));
    this.tracker = new GeofenceTracker([...inputs.fences, ...defaults]);
    this.library = libraryFromBundle(content);
    this.names = new Map([...content.places, ...content.anchors].map((p) => [p.ref, p.name]));
  }

  name(ref: string): string {
    return this.names.get(ref) ?? ref;
  }

  get visited(): string[] {
    return this.memory.visitedPlaces;
  }

  /** Tappa successiva del piano non ancora visitata. */
  get nextStop(): string | null {
    return this.plan?.stops.find((s) => !this.memory.visitedPlaces.includes(s.placeId))?.placeId ?? null;
  }

  startTour(options: TourOptions): TourPlan {
    this.memory = emptyMemory();
    this.narratedHere.clear();
    this.anchor = null;
    if (options.anchor) {
      const a = this.anchors.find((x) => x.id === options.anchor!.ref);
      if (!a) throw new Error(`ancora sconosciuta: ${options.anchor.ref}`);
      this.anchor = { ...a, deadline: options.anchor.deadline };
    }
    this.plan = planTour({
      now: options.now,
      start: { location: options.start },
      candidates: this.places,
      ...(options.budgetMin !== undefined ? { budgetMin: options.budgetMin } : {}),
      ...(this.anchor ? { anchor: this.anchor } : {}),
      ...(options.avoidStairs !== undefined ? { avoidStairs: options.avoidStairs } : {}),
      ...(options.interests ? { interests: options.interests } : {}),
    });
    return this.plan;
  }

  /** Elabora una posizione. */
  onFix(fix: Fix): RuntimeEvent[] {
    this.lastFix = fix;
    this.motion = this.motionDetector.update(fix);
    const events: RuntimeEvent[] = [];

    for (const e of this.tracker.update(fix)) {
      if (e.kind !== "arrival") continue;
      if (e.type === "exit") {
        if (this.currentPlaceRef === e.placeId) this.currentPlaceRef = null;
        if (this.pendingProposal === e.placeId) this.pendingProposal = null;
        continue;
      }
      // Su un mezzo (battello, auto) non si propone nulla.
      if (this.motion === "vehicle") continue;
      this.currentPlaceRef = e.placeId;
      const name = this.name(e.placeId);
      events.push({ type: "arrived", placeRef: e.placeId, name });
      if (this.narratedHere.has(e.placeId)) continue;
      // Niente da raccontare (o già raccontato tutto): si segna la visita e non si disturba.
      if (this.mode !== "silent" && this.planFor(e.placeId).items.length === 0) {
        this.narratedHere.add(e.placeId);
        this.markVisited(e.placeId);
        if (this.isTourComplete()) events.push({ type: "tour_complete" });
        continue;
      }
      if (this.mode === "auto") events.push(...this.narrate(e.placeId, fix.timestamp));
      else if (this.mode === "ask") {
        this.pendingProposal = e.placeId;
        events.push({ type: "proposal", placeRef: e.placeId, name });
      }
    }

    if (this.anchor) {
      const status = anchorStatus({ now: fix.timestamp, position: { location: fix.location }, anchor: this.anchor });
      if (status.level !== this.lastAnchorStatus?.level) events.push({ type: "anchor", status });
      this.lastAnchorStatus = status;
    }
    return events;
  }

  /** Il visitatore accetta la proposta di racconto. */
  acceptProposal(now: number): RuntimeEvent[] {
    const place = this.pendingProposal;
    this.pendingProposal = null;
    return place ? this.narrate(place, now) : [];
  }

  declineProposal(): void {
    this.pendingProposal = null;
  }

  /** Racconta il luogo indicato (o quello corrente), anche su richiesta esplicita. */
  narrate(placeRef: string | null = this.currentPlaceRef, _now = Date.now()): RuntimeEvent[] {
    if (!placeRef) return [];
    const place = this.places.find((p) => p.id === placeRef);
    if (!place) return [];
    this.narratedHere.add(placeRef);
    const stop = this.planFor(placeRef);
    this.memory = applyStopPlan(this.memory, stop, this.library);
    this.markVisited(placeRef);

    const name = this.name(placeRef);
    const events: RuntimeEvent[] = [];
    if (stop.items.length === 0) events.push({ type: "nothing_new", placeRef, name });
    else {
      const segments: NarrationSegment[] = stop.items.map((item) => ({
        id: `s${++this.segmentCounter}`,
        kind: item.kind === "unit" ? "unit" : "bridge",
        text: item.kind === "unit" ? this.library.units.get(item.unitRef)!.text : renderBridgeTemplate(item, this.content.locale, this.library),
        placeRef,
      }));
      events.push({ type: "narration", placeRef, name, segments });
    }
    if (this.isTourComplete()) events.push({ type: "tour_complete" });
    return events;
  }

  /** Piano narrativo per un luogo, senza modificare la memoria. */
  planFor(placeRef: string): StopPlan {
    const place = this.places.find((p) => p.id === placeRef);
    const next = this.plan?.stops.find((s) => s.placeId !== placeRef && !this.memory.visitedPlaces.includes(s.placeId));
    return planStop({
      library: this.library,
      memory: this.memory,
      placeRef,
      locale: this.content.locale,
      audience: this.audience,
      timeBudgetS: narrationBudgetS(place?.dwellMin ?? 5),
      nextPlaceRef: next?.placeId ?? null,
    });
  }

  private markVisited(placeRef: string): void {
    if (!this.memory.visitedPlaces.includes(placeRef)) {
      this.memory = { ...this.memory, visitedPlaces: [...this.memory.visitedPlaces, placeRef] };
    }
  }

  private isTourComplete(): boolean {
    return !!this.plan && this.plan.stops.length > 0 && this.plan.stops.every((s) => this.memory.visitedPlaces.includes(s.placeId));
  }
}
