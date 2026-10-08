import type { AnchorTarget, TourPlan } from "./planner.ts";
import { toblerEstimator, type Point, type WalkEstimator } from "./walking.ts";

/**
 * Sorveglia il tempo durante il tour.
 *
 * - ok:        c'è tempo
 * - soon:      tra poco bisogna avviarsi verso l'ancora (avviso)
 * - leave_now: bisogna partire ora; si sta già usando il margine di sicurezza
 * - late:      anche partendo ora non si arriva in tempo
 */

export type AnchorLevel = "ok" | "soon" | "leave_now" | "late";

export interface AnchorStatus {
  anchorId: string;
  level: AnchorLevel;
  /** Ultimo momento per partire rispettando il margine di sicurezza. */
  leaveBy: number;
  minutesToLeave: number;
  walkMin: number;
}

export function anchorStatus(params: {
  now: number;
  position: Point;
  anchor: AnchorTarget;
  estimator?: WalkEstimator;
  warnAheadMin?: number;
}): AnchorStatus {
  const estimator = params.estimator ?? toblerEstimator();
  const walkMs = estimator.seconds(params.position, params.anchor) * 1000;
  const leaveBy = params.anchor.deadline - params.anchor.safetyMarginMin * 60_000 - walkMs;
  const latest = params.anchor.deadline - walkMs;
  const warnMs = (params.warnAheadMin ?? 10) * 60_000;
  const level: AnchorLevel =
    params.now < leaveBy - warnMs ? "ok" : params.now < leaveBy ? "soon" : params.now < latest ? "leave_now" : "late";
  return {
    anchorId: params.anchor.id,
    level,
    leaveBy,
    minutesToLeave: (leaveBy - params.now) / 60_000,
    walkMin: walkMs / 60_000,
  };
}

/** Il visitatore è in ritardo rispetto al piano: conviene ripianificare. */
export function shouldReplan(plan: TourPlan, now: number, nextStopIndex: number, toleranceMin = 5): boolean {
  const next = plan.stops[nextStopIndex];
  if (!next) return false;
  return now > next.arriveAt + toleranceMin * 60_000;
}
