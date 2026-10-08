import { bearingDeg, destination, distanceM, type LngLat } from "../src/geo.ts";
import type { Fix } from "../src/fix.ts";

/**
 * Simulatore di passeggiate per i test: genera tracce GPS deterministiche
 * con rumore, come quelle di un telefono reale in un centro storico.
 */

/** Generatore pseudocasuale deterministico (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Walker {
  fixes: Fix[];
  position: LngLat;
  time: number;
}

export interface TraceOptions {
  noiseM?: number;
  accuracyM?: number;
  compassDeg?: number;
  seed?: number;
}

function noisy(point: LngLat, random: () => number, noiseM: number): LngLat {
  if (noiseM === 0) return point;
  return destination(point, random() * 360, random() * noiseM);
}

export function startWalk(at: LngLat, time = Date.UTC(2026, 4, 15, 10, 0, 0)): Walker {
  return { fixes: [], position: at, time };
}

/** Cammina in linea retta verso `to` a `speedMs`, un fix al secondo. */
export function walkTo(w: Walker, to: LngLat, speedMs = 1.3, options: TraceOptions = {}): Walker {
  const random = rng(options.seed ?? 1);
  const total = distanceM(w.position, to);
  const heading = bearingDeg(w.position, to);
  const steps = Math.max(1, Math.ceil(total / speedMs));
  for (let i = 1; i <= steps; i++) {
    const p = destination(w.position, heading, Math.min(total, i * speedMs));
    w.time += 1000;
    w.fixes.push({
      location: noisy(p, random, options.noiseM ?? 0),
      accuracyM: options.accuracyM ?? 10,
      timestamp: w.time,
      compassDeg: options.compassDeg,
    });
  }
  w.position = to;
  return w;
}

/** Resta fermo per `seconds`, con il rumore tipico del GPS. */
export function stay(w: Walker, seconds: number, options: TraceOptions = {}): Walker {
  const random = rng(options.seed ?? 2);
  for (let i = 0; i < seconds; i++) {
    w.time += 1000;
    w.fixes.push({
      location: noisy(w.position, random, options.noiseM ?? 0),
      accuracyM: options.accuracyM ?? 10,
      timestamp: w.time,
      compassDeg: options.compassDeg,
    });
  }
  return w;
}
