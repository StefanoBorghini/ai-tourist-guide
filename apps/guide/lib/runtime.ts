import {
  anchorStatus,
  bearingDeg,
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
 *
 * Due modi d'uso, sullo stesso motore (GPS, geofence, luoghi, fonti, narrazione):
 * - "explore": esplorazione libera. Nessun piano né tappe: ogni luogo del territorio può essere
 *   proposto quando ci si arriva, nell'ordine in cui il visitatore cammina;
 * - "tour": percorso guidato (curato o su misura) con tappe ordinate.
 * Cambia solo l'organizzazione. La memoria del racconto (cosa è già stato detto) è della visita e
 * sopravvive ai cambi di modalità; l'avanzamento delle tappe (`reached`) è del singolo percorso.
 */

export type RuntimeKind = "explore" | "tour";

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

/** Un luogo rifiutato non viene riproposto prima di questo intervallo (rientri dovuti al GPS che oscilla). */
export const DECLINE_COOLDOWN_MS = 15 * 60_000;

/** Stato serializzabile del giro (per riprenderlo dopo la sospensione dell'app). */
export interface RuntimeState {
  memory: TourMemory;
  narratedHere: string[];
  skipped: string[];
  manualArrivals: string[];
  currentPlaceRef: string | null;
  /** Luoghi rifiutati e quando (ms). Assente negli stati salvati dalle versioni precedenti. */
  declined?: [string, number][];
  /** Tappe raggiunte nel percorso in corso. Assente nei salvataggi precedenti: si usano i luoghi visitati. */
  reached?: string[];
}

/** Luogo vicino alla posizione: distanza e direzione in linea d'aria, calcolate dal sistema. */
export interface NearbyPlace {
  ref: string;
  name: string;
  distanceM: number;
  bearingDeg: number;
  coordinateStatus: string;
  narrated: boolean;
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
  /** Modo d'uso corrente; null finché non si avvia né un'esplorazione né un itinerario. */
  kind: RuntimeKind | null = null;
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
  /**
   * Vero mentre la guida sta parlando (lo imposta l'interfaccia): i luoghi raggiunti intanto
   * aspettano, così un luogo vicino non interrompe il racconto in corso.
   */
  narrating = false;
  private narratedHere = new Set<string>();
  /** Luoghi in cui il visitatore è entrato e che aspettano di essere proposti, in ordine di ingresso. */
  private waiting: string[] = [];
  private declined = new Map<string, number>();
  /** Luoghi raggiunti (o saltati) da quando è iniziata l'organizzazione corrente: l'avanzamento del percorso. */
  private reached = new Set<string>();
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

  /** Luoghi raggiunti nel percorso (o nell'esplorazione) in corso. */
  get visited(): string[] {
    return [...this.reached];
  }

  /** Tappa successiva del piano non ancora raggiunta. */
  get nextStop(): string | null {
    return this.plan?.stops.find((s) => !this.reached.has(s.placeId))?.placeId ?? null;
  }

  /** Riparte da zero: nessun luogo visitato né raccontato. */
  private resetMemory(): void {
    this.memory = emptyMemory();
    this.narratedHere.clear();
    this.manualArrivals = [];
    this.declined.clear();
    this.currentPlaceRef = null;
  }

  private resetPlan(): void {
    this.reached.clear();
    this.skipped = [];
    this.pendingProposal = null;
    this.waiting = [];
    this.anchor = null;
    this.lastAnchorStatus = null;
  }

  /**
   * Esplorazione libera: nessun piano, nessuna tappa obbligata, tutti i luoghi attivi.
   * Con keepMemory (passaggio da un itinerario) ciò che è già stato raccontato non si ripete.
   */
  startExplore(options: { keepMemory?: boolean } = {}): void {
    if (!options.keepMemory) this.resetMemory();
    this.resetPlan();
    this.kind = "explore";
    this.plan = null;
    this.routeStops = null;
  }

  startTour(options: TourOptions & { keepMemory?: boolean }): TourPlan {
    if (!options.keepMemory) this.resetMemory();
    this.resetPlan();
    this.kind = "tour";
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
        this.waiting = this.waiting.filter((p) => p !== e.placeId);
        continue;
      }
      // In un percorso curato i luoghi fuori percorso non interrompono: il debug li mostra comunque.
      if (this.routeStops && !this.routeStops.includes(e.placeId)) continue;
      if (!this.waiting.includes(e.placeId)) this.waiting.push(e.placeId);
    }
    events.push(...this.processWaiting(fix));

    if (this.anchor) {
      const status = anchorStatus({ now: fix.timestamp, position: { location: fix.location }, anchor: this.anchor });
      if (status.level !== this.lastAnchorStatus?.level) events.push({ type: "anchor", status });
      this.lastAnchorStatus = status;
    }
    return events;
  }

  /**
   * Propone (o racconta) al più un luogo raggiunto per posizione. I luoghi restano in attesa finché
   * il visitatore è dentro il loro geofence e:
   * - non è su un mezzo (battello, auto): chi scende dal battello riceve la proposta appena cammina;
   * - la guida non sta parlando e non c'è una proposta aperta: niente interruzioni;
   * tra più luoghi in attesa (geofence sovrapposti) vince il più vicino al visitatore.
   */
  private processWaiting(fix: Fix): RuntimeEvent[] {
    if (this.waiting.length === 0 || this.motion === "vehicle" || this.narrating || this.pendingProposal) return [];
    const location = (ref: string) => this.places.find((p) => p.id === ref)?.location;
    const [ref] = [...this.waiting].sort((a, b) => {
      const la = location(a);
      const lb = location(b);
      return (la ? distanceM(fix.location, la) : Infinity) - (lb ? distanceM(fix.location, lb) : Infinity);
    });
    this.waiting = this.waiting.filter((p) => p !== ref);
    return this.handleArrival(ref!, fix.timestamp);
  }

  /** Arrivo in un luogo (da geofence o confermato a mano): proposta o racconto secondo la modalità. */
  private handleArrival(placeRef: string, now: number, manual = false): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    this.currentPlaceRef = placeRef;
    const name = this.name(placeRef);
    events.push({ type: "arrived", placeRef, name });
    if (this.narratedHere.has(placeRef)) {
      // Già raccontato (magari esplorando prima di scegliere il percorso): non si ripete, ma la tappa conta.
      this.reached.add(placeRef);
      if (this.isTourComplete()) events.push({ type: "tour_complete" });
      return events;
    }
    // Rifiutato da poco: si segna dove si è, senza chiedere di nuovo.
    const declinedAt = this.declined.get(placeRef);
    if (!manual && declinedAt !== undefined && now - declinedAt < DECLINE_COOLDOWN_MS) return events;
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
    this.waiting = this.waiting.filter((p) => p !== placeRef);
    return this.handleArrival(placeRef, now, true);
  }

  /** Il visitatore salta una tappa: si passa alla successiva senza raccontarla. */
  skipStop(placeRef: string): RuntimeEvent[] {
    if (!this.skipped.includes(placeRef)) this.skipped.push(placeRef);
    if (this.pendingProposal === placeRef) this.pendingProposal = null;
    this.waiting = this.waiting.filter((p) => p !== placeRef);
    // Saltata nel percorso, non raccontata: passando all'esplorazione libera potrà essere proposta.
    this.reached.add(placeRef);
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
      declined: [...this.declined],
      reached: [...this.reached],
    };
  }

  /** Ripristina uno stato salvato (dopo startTour con le stesse opzioni). */
  restoreState(state: RuntimeState): void {
    this.memory = state.memory;
    this.narratedHere = new Set(state.narratedHere);
    this.skipped = [...state.skipped];
    this.manualArrivals = [...state.manualArrivals];
    this.currentPlaceRef = state.currentPlaceRef;
    this.declined = new Map(state.declined ?? []);
    this.reached = new Set(state.reached ?? state.memory.visitedPlaces);
  }

  /** Il visitatore accetta la proposta di racconto. */
  acceptProposal(now: number): RuntimeEvent[] {
    const place = this.pendingProposal;
    this.pendingProposal = null;
    return place ? this.narrate(place, now) : [];
  }

  declineProposal(now = Date.now()): void {
    if (this.pendingProposal) this.declined.set(this.pendingProposal, now);
    this.pendingProposal = null;
  }

  /** Il racconto di questo luogo è già stato ascoltato in questa visita? */
  wasNarrated(placeRef: string): boolean {
    return this.narratedHere.has(placeRef);
  }

  /**
   * Luoghi ordinati per distanza dall'ultima posizione (in linea d'aria, dalle coordinate del pack:
   * finché non sono verificate sul campo sono indicative). Vuoto senza posizione.
   */
  nearby(limit = 5, maxM = Infinity): NearbyPlace[] {
    const fix = this.lastFix;
    if (!fix) return [];
    return this.content.places
      .map((p) => ({
        ref: p.ref,
        name: p.name,
        distanceM: Math.round(distanceM(fix.location, p.location)),
        bearingDeg: Math.round(bearingDeg(fix.location, p.location)),
        coordinateStatus: p.coordinateStatus,
        narrated: this.narratedHere.has(p.ref),
      }))
      .filter((p) => p.distanceM <= maxM)
      .sort((a, b) => a.distanceM - b.distanceM || a.name.localeCompare(b.name))
      .slice(0, limit);
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
    const next = this.plan?.stops.find((s) => s.placeId !== placeRef && !this.reached.has(s.placeId));
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
    this.reached.add(placeRef);
    if (!this.memory.visitedPlaces.includes(placeRef)) {
      this.memory = { ...this.memory, visitedPlaces: [...this.memory.visitedPlaces, placeRef] };
    }
  }

  private isTourComplete(): boolean {
    return !!this.plan && this.plan.stops.length > 0 && this.plan.stops.every((s) => this.reached.has(s.placeId));
  }
}
