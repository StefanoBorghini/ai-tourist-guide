import {
  anchorStatus,
  distanceM,
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
  /** Percorso curato (riferimento completo): tappe e ordine li decide la redazione. */
  route?: string;
}

/**
 * Area di arrivo predefinita per i luoghi che non ne hanno una nel pack:
 * ogni tappa di un tour deve poter essere riconosciuta.
 */
export const DEFAULT_ARRIVAL_RADIUS_M = 25;

const INVITE = {
  it: "Se hai domande su questo luogo, chiedimi pure.",
  en: "If you have any questions about this place, just ask.",
} as const;

/** Stato serializzabile del giro (per riprenderlo dopo la sospensione dell'app). */
export interface RuntimeState {
  memory: TourMemory;
  narratedHere: string[];
  skipped: string[];
  manualArrivals: string[];
  currentPlaceRef: string | null;
}

/** Istantanea per la modalità debug del test sul campo. */
export interface DebugSnapshot {
  fix: Fix | null;
  motion: Motion;
  currentPlaceRef: string | null;
  pendingProposal: string | null;
  places: {
    ref: string;
    name: string;
    distanceM: number | null;
    coordinateStatus: string;
    storyStatus: string | null;
    notes: string[];
    narratable: number;
    fences: { kind: string; radiusM: number; phase: string; tooImprecise: boolean }[];
  }[];
}

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
  /** Se vero, dopo il racconto di un luogo la guida invita a fare domande. */
  inviteQuestions = false;
  /** Tappe del percorso curato scelto (riferimenti completi), oppure null nel giro libero. */
  routeStops: string[] | null = null;
  /** Tappe saltate a mano dal visitatore. */
  skipped: string[] = [];
  /** Arrivi confermati a mano (GPS impreciso o coordinate sbagliate). */
  manualArrivals: string[] = [];
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
    this.skipped = [];
    this.manualArrivals = [];
    this.currentPlaceRef = null;
    this.pendingProposal = null;
    this.anchor = null;
    if (options.anchor) {
      const a = this.anchors.find((x) => x.id === options.anchor!.ref);
      if (!a) throw new Error(`ancora sconosciuta: ${options.anchor.ref}`);
      this.anchor = { ...a, deadline: options.anchor.deadline };
    }
    const route = options.route ? this.content.routes.find((r) => r.ref === options.route) : undefined;
    if (options.route && !route) throw new Error(`percorso sconosciuto: ${options.route}`);
    const candidates = route
      ? route.stops.flatMap((s) => {
          const place = this.places.find((p) => p.id === s.place);
          return place ? [{ ...place, dwellMin: s.dwellMin ?? place.dwellMin }] : [];
        })
      : this.places;
    const budgetMin = options.budgetMin ?? route?.durationMin;
    this.routeStops = route ? candidates.map((c) => c.id) : null;
    this.plan = planTour({
      now: options.now,
      start: { location: options.start },
      candidates,
      ...(route ? { fixedOrder: true } : {}),
      ...(budgetMin !== undefined ? { budgetMin } : {}),
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
      // In un percorso curato i luoghi fuori percorso non interrompono: il debug li mostra comunque.
      if (this.routeStops && !this.routeStops.includes(e.placeId)) continue;
      events.push(...this.handleArrival(e.placeId, fix.timestamp));
    }

    if (this.anchor) {
      const status = anchorStatus({ now: fix.timestamp, position: { location: fix.location }, anchor: this.anchor });
      if (status.level !== this.lastAnchorStatus?.level) events.push({ type: "anchor", status });
      this.lastAnchorStatus = status;
    }
    return events;
  }

  /** Arrivo in un luogo (da geofence o confermato a mano): proposta o racconto secondo la modalità. */
  private handleArrival(placeRef: string, now: number, manual = false): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    this.currentPlaceRef = placeRef;
    const name = this.name(placeRef);
    events.push({ type: "arrived", placeRef, name });
    if (this.narratedHere.has(placeRef)) return events;
    // Niente da raccontare (o già raccontato tutto): si segna la visita e non si disturba.
    if (this.mode !== "silent" && this.planFor(placeRef).items.length === 0) {
      this.narratedHere.add(placeRef);
      this.markVisited(placeRef);
      if (this.isTourComplete()) events.push({ type: "tour_complete" });
      return events;
    }
    // Nel percorso, il racconto parte da solo solo per la tappa attesa; per le altre si chiede.
    const expected = !this.routeStops || this.nextStop === placeRef;
    if (manual || (this.mode === "auto" && expected)) events.push(...this.narrate(placeRef, now));
    else if (this.mode !== "silent") {
      this.pendingProposal = placeRef;
      events.push({ type: "proposal", placeRef, name });
    }
    return events;
  }

  /**
   * Il visitatore dichiara di essere arrivato (pulsante "Sono qui"): serve quando il GPS è impreciso
   * o le coordinate del luogo non sono ancora verificate. Racconta subito.
   */
  arriveManually(placeRef: string, now: number): RuntimeEvent[] {
    if (!this.places.some((p) => p.id === placeRef)) return [];
    if (!this.manualArrivals.includes(placeRef)) this.manualArrivals.push(placeRef);
    this.pendingProposal = null;
    return this.handleArrival(placeRef, now, true);
  }

  /** Il visitatore salta una tappa: si passa alla successiva senza raccontarla. */
  skipStop(placeRef: string): RuntimeEvent[] {
    if (!this.skipped.includes(placeRef)) this.skipped.push(placeRef);
    if (this.pendingProposal === placeRef) this.pendingProposal = null;
    this.narratedHere.add(placeRef);
    this.markVisited(placeRef);
    return this.isTourComplete() ? [{ type: "tour_complete" }] : [];
  }

  /** Stato da salvare per riprendere il giro dopo una sospensione dell'app. */
  exportState(): RuntimeState {
    return {
      memory: this.memory,
      narratedHere: [...this.narratedHere],
      skipped: [...this.skipped],
      manualArrivals: [...this.manualArrivals],
      currentPlaceRef: this.currentPlaceRef,
    };
  }

  /** Ripristina uno stato salvato (dopo startTour con le stesse opzioni). */
  restoreState(state: RuntimeState): void {
    this.memory = state.memory;
    this.narratedHere = new Set(state.narratedHere);
    this.skipped = [...state.skipped];
    this.manualArrivals = [...state.manualArrivals];
    this.currentPlaceRef = state.currentPlaceRef;
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
      // Invito a fare domande: frase fissa, senza fatti, solo se le domande sono disponibili.
      if (this.inviteQuestions) {
        segments.push({ id: `s${++this.segmentCounter}`, kind: "bridge", text: INVITE[this.content.locale === "it" ? "it" : "en"], placeRef });
      }
      events.push({ type: "narration", placeRef, name, segments });
    }
    if (this.isTourComplete()) events.push({ type: "tour_complete" });
    return events;
  }

  /** Stato completo per la diagnostica sul campo: luoghi ordinati per distanza, geofence, stati redazionali. */
  debugSnapshot(): DebugSnapshot {
    const fix = this.lastFix;
    const fences = this.tracker.inspect();
    const units = [...this.library.units.values()];
    const places = this.content.places
      .map((p) => ({
        ref: p.ref,
        name: p.name,
        distanceM: fix ? Math.round(distanceM(fix.location, p.location)) : null,
        coordinateStatus: p.coordinateStatus,
        storyStatus: p.curation?.storyStatus ?? null,
        notes: p.curation?.notes ?? [],
        narratable: units.filter((u) => u.anchor === p.ref).length,
        fences: fences
          .filter((f) => f.placeId === p.ref)
          .map((f) => ({ kind: f.kind, radiusM: f.radiusM, phase: f.phase, tooImprecise: !!fix && fix.accuracyM > f.maxAccuracyM })),
      }))
      .sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0) || a.name.localeCompare(b.name));
    return { fix, motion: this.motion, currentPlaceRef: this.currentPlaceRef, pendingProposal: this.pendingProposal, places };
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
