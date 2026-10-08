import { angleDiffDeg, bearingDeg, distanceM, relativeDirection, type RelativeDirection } from "./geo.ts";
import type { Fix } from "./fix.ts";
import type { FenceDefinition } from "./geofence.ts";
import type { Motion } from "./motion.ts";
import { anchorStatus, type AnchorStatus } from "./monitor.ts";
import type { AnchorTarget, TourPlan } from "./planner.ts";
import { toblerEstimator, type Point, type WalkEstimator } from "./walking.ts";

/**
 * Istantanea del contesto: ciò che il motore narrativo (e l'AI) riceve.
 * Non contiene coordinate del visitatore: solo luoghi, distanze e direzioni.
 */

export interface ContextPlace extends Point {
  id: string;
  importance: number;
}

export interface NearbyPlace {
  placeId: string;
  distanceM: number;
  bearingDeg: number;
  /** Rispetto a dove si guarda; null se la bussola non è disponibile. */
  direction: RelativeDirection | null;
}

export interface ContextSnapshot {
  at: number;
  motion: Motion;
  currentPlaceId: string | null;
  /** Luoghi che si stanno guardando da un punto panoramico (bussola confermata). */
  inViewPlaceIds: string[];
  nearby: NearbyPlace[];
  visitedPlaceIds: string[];
  nextStop: { placeId: string; walkMin: number } | null;
  anchor: AnchorStatus | null;
}

export interface SnapshotInput {
  now: number;
  fix: Fix;
  motion: Motion;
  places: readonly ContextPlace[];
  fences: readonly FenceDefinition[];
  activeFenceIds: readonly string[];
  visited: ReadonlySet<string>;
  plan?: TourPlan;
  nextStopIndex?: number;
  anchor?: AnchorTarget;
  estimator?: WalkEstimator;
  nearbyRadiusM?: number;
  maxNearby?: number;
}

/**
 * Sceglie il luogo "corrente" tra i geofence di arrivo attivi:
 * importanza, vicinanza al centro, tappa successiva del tour, già visitato.
 */
export function pickCurrentPlace(input: SnapshotInput): string | null {
  const byId = new Map(input.places.map((p) => [p.id, p]));
  const nextPlaceId = input.plan?.stops[input.nextStopIndex ?? 0]?.placeId;
  let best: { id: string; score: number } | null = null;
  for (const fence of input.fences) {
    if (fence.kind !== "arrival" || !input.activeFenceIds.includes(fence.id)) continue;
    const place = byId.get(fence.placeId);
    if (!place) continue;
    const proximity = 1 - Math.min(1, distanceM(input.fix.location, fence.center) / fence.radiusM);
    const score =
      place.importance * 2 + proximity * 2 + (fence.placeId === nextPlaceId ? 3 : 0) - (input.visited.has(place.id) ? 2 : 0);
    if (!best || score > best.score) best = { id: place.id, score };
  }
  return best?.id ?? null;
}

export function buildContextSnapshot(input: SnapshotInput): ContextSnapshot {
  const radius = input.nearbyRadiusM ?? 250;
  const currentPlaceId = pickCurrentPlace(input);
  const compass = input.fix.compassDeg;

  const nearby = input.places
    .filter((p) => p.id !== currentPlaceId)
    .map((p) => {
      const d = distanceM(input.fix.location, p.location);
      const b = bearingDeg(input.fix.location, p.location);
      return { placeId: p.id, distanceM: Math.round(d), bearingDeg: Math.round(b), direction: compass === undefined ? null : relativeDirection(compass, b) };
    })
    .filter((p) => p.distanceM <= radius)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, input.maxNearby ?? 5);

  const inViewPlaceIds = input.fences
    .filter((f) => f.kind === "viewpoint" && input.activeFenceIds.includes(f.id))
    .filter(
      (f) =>
        compass !== undefined &&
        f.viewBearingDeg !== undefined &&
        angleDiffDeg(compass, f.viewBearingDeg) <= (f.viewToleranceDeg ?? 45),
    )
    .map((f) => f.placeId);

  const estimator = input.estimator ?? toblerEstimator();
  let nextStop: ContextSnapshot["nextStop"] = null;
  const next = input.plan?.stops[input.nextStopIndex ?? 0];
  const nextPlace = next ? input.places.find((p) => p.id === next.placeId) : undefined;
  if (nextPlace) {
    nextStop = { placeId: nextPlace.id, walkMin: estimator.seconds({ location: input.fix.location }, nextPlace) / 60 };
  }

  return {
    at: input.now,
    motion: input.motion,
    currentPlaceId,
    inViewPlaceIds,
    nearby,
    visitedPlaceIds: [...input.visited].sort(),
    nextStop,
    anchor: input.anchor
      ? anchorStatus({
          now: input.now,
          position: { location: input.fix.location },
          anchor: input.anchor,
          estimator,
        })
      : null,
  };
}
