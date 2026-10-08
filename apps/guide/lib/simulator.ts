import { bearingDeg, destination, distanceM, type Fix, type LngLat } from "@guide/context-engine";

/**
 * Simulatore di passeggiata: genera una traccia GPS lungo una sequenza di punti,
 * con soste. Serve a provare la guida senza essere sul posto (e per il territorio
 * di prova, che è inventato).
 */

export interface SimStop {
  location: LngLat;
  dwellS: number;
}

export interface SimOptions {
  startTime: number;
  speedMs?: number;
  stepS?: number;
  accuracyM?: number;
}

export function simulateWalk(start: LngLat, stops: readonly SimStop[], options: SimOptions): Fix[] {
  const speed = options.speedMs ?? 1.3;
  const step = options.stepS ?? 1;
  const accuracy = options.accuracyM ?? 8;
  const fixes: Fix[] = [];
  let t = options.startTime;
  let here: LngLat = start;
  const push = (location: LngLat) => {
    t += step * 1000;
    fixes.push({ location, accuracyM: accuracy, timestamp: t, speedMs: undefined });
  };

  for (const stop of stops) {
    const total = distanceM(here, stop.location);
    const heading = bearingDeg(here, stop.location);
    for (let d = speed * step; d < total; d += speed * step) push(destination(here, heading, d));
    push(stop.location);
    for (let s = 0; s < stop.dwellS; s += step) push(stop.location);
    here = stop.location;
  }
  return fixes;
}
