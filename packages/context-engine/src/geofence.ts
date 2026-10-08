import type { GeofenceKind } from "@guide/domain";
import { angleDiffDeg, distanceM, type LngLat } from "./geo.ts";
import type { Fix } from "./fix.ts";

/**
 * Geofence sul dispositivo.
 *
 * Ogni geofence ha una piccola macchina a stati:
 *
 *   outside → entering (dentro, ma non ancora per abbastanza tempo)
 *   entering → inside  (dentro per almeno minDwellS secondi) → evento "enter"
 *   inside → exiting   (oltre raggio × exitFactor)
 *   exiting → outside  (fuori per almeno exitGraceS secondi) → evento "exit"
 *
 * La permanenza minima evita i trigger di chi passa di corsa; l'isteresi
 * (exitFactor) evita il "ping-pong" quando il GPS oscilla sul bordo.
 * Le posizioni troppo imprecise per un geofence vengono ignorate per quel geofence.
 */

export interface FenceDefinition {
  id: string;
  placeId: string;
  kind: GeofenceKind;
  center: LngLat;
  radiusM: number;
  minDwellS: number;
  maxAccuracyM: number;
  exitFactor?: number;
  /** Solo viewpoint: direzione in cui si vede il luogo e tolleranza. */
  viewBearingDeg?: number | undefined;
  viewToleranceDeg?: number | undefined;
}

export interface GeofenceEvent {
  type: "enter" | "exit";
  fenceId: string;
  placeId: string;
  kind: GeofenceKind;
  timestamp: number;
  distanceM: number;
  /** Per i viewpoint: la bussola conferma che si guarda nella direzione giusta. */
  facingConfirmed?: boolean;
}

type FenceState =
  | { phase: "outside" }
  | { phase: "entering"; since: number }
  | { phase: "inside"; since: number }
  | { phase: "exiting"; insideSince: number; since: number };

const DEFAULT_EXIT_FACTOR = 1.3;
const EXIT_GRACE_S = 10;
const DEFAULT_VIEW_TOLERANCE = 45;

export class GeofenceTracker {
  private readonly states = new Map<string, FenceState>();

  constructor(private readonly fences: readonly FenceDefinition[]) {
    for (const f of fences) this.states.set(f.id, { phase: "outside" });
  }

  /** Elabora una posizione e restituisce gli eventi generati. */
  update(fix: Fix): GeofenceEvent[] {
    const events: GeofenceEvent[] = [];
    for (const fence of this.fences) {
      if (fix.accuracyM > fence.maxAccuracyM) continue;
      const state = this.states.get(fence.id)!;
      const d = distanceM(fix.location, fence.center);
      const inside = d <= fence.radiusM;
      const beyondExit = d > fence.radiusM * (fence.exitFactor ?? DEFAULT_EXIT_FACTOR);
      const t = fix.timestamp;
      const event = (type: GeofenceEvent["type"]): GeofenceEvent => ({
        type,
        fenceId: fence.id,
        placeId: fence.placeId,
        kind: fence.kind,
        timestamp: t,
        distanceM: d,
        ...(fence.kind === "viewpoint" && type === "enter" ? { facingConfirmed: isFacing(fence, fix) } : {}),
      });

      switch (state.phase) {
        case "outside":
          if (inside) {
            if (fence.minDwellS === 0) {
              this.states.set(fence.id, { phase: "inside", since: t });
              events.push(event("enter"));
            } else {
              this.states.set(fence.id, { phase: "entering", since: t });
            }
          }
          break;
        case "entering":
          if (!inside) {
            this.states.set(fence.id, { phase: "outside" });
          } else if (t - state.since >= fence.minDwellS * 1000) {
            this.states.set(fence.id, { phase: "inside", since: t });
            events.push(event("enter"));
          }
          break;
        case "inside":
          if (beyondExit) this.states.set(fence.id, { phase: "exiting", insideSince: state.since, since: t });
          break;
        case "exiting":
          if (!beyondExit) {
            this.states.set(fence.id, { phase: "inside", since: state.insideSince });
          } else if (t - state.since >= EXIT_GRACE_S * 1000) {
            this.states.set(fence.id, { phase: "outside" });
            events.push(event("exit"));
          }
          break;
      }
    }
    return events;
  }

  /** Geofence in cui il visitatore si trova ora (inside o in uscita non ancora confermata). */
  activeFenceIds(): string[] {
    return [...this.states].filter(([, s]) => s.phase === "inside" || s.phase === "exiting").map(([id]) => id);
  }
}

function isFacing(fence: FenceDefinition, fix: Fix): boolean {
  if (fence.viewBearingDeg === undefined || fix.compassDeg === undefined) return false;
  return angleDiffDeg(fix.compassDeg, fence.viewBearingDeg) <= (fence.viewToleranceDeg ?? DEFAULT_VIEW_TOLERANCE);
}
