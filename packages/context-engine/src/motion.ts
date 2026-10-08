import { distanceM } from "./geo.ts";
import type { Fix } from "./fix.ts";

/**
 * Riconosce se il visitatore è fermo, cammina o è su un mezzo (battello, auto),
 * dalla velocità media sugli ultimi secondi.
 *
 * Serve alla modalità "solo quando mi fermo" e a non proporre racconti a chi
 * passa in battello davanti a un luogo.
 */

export type Motion = "unknown" | "stationary" | "walking" | "vehicle";

export interface MotionOptions {
  windowS?: number;
  stationaryBelowMs?: number;
  vehicleAboveMs?: number;
  maxAccuracyM?: number;
}

export class MotionDetector {
  private readonly fixes: Fix[] = [];
  private readonly windowMs: number;
  private readonly stationaryBelow: number;
  private readonly vehicleAbove: number;
  private readonly maxAccuracy: number;

  constructor(options: MotionOptions = {}) {
    this.windowMs = (options.windowS ?? 20) * 1000;
    this.stationaryBelow = options.stationaryBelowMs ?? 0.5;
    this.vehicleAbove = options.vehicleAboveMs ?? 7;
    this.maxAccuracy = options.maxAccuracyM ?? 50;
  }

  update(fix: Fix): Motion {
    if (fix.accuracyM <= this.maxAccuracy) {
      this.fixes.push(fix);
      while (this.fixes.length > 2 && fix.timestamp - this.fixes[0]!.timestamp > this.windowMs) this.fixes.shift();
    }
    return this.current();
  }

  current(): Motion {
    if (this.fixes.length < 2) return "unknown";
    const first = this.fixes[0]!;
    const last = this.fixes.at(-1)!;
    const spanMs = last.timestamp - first.timestamp;
    // Serve almeno il 75% della finestra per dare un giudizio.
    if (spanMs < this.windowMs * 0.75) return "unknown";

    const reported = this.fixes.map((f) => f.speedMs).filter((s): s is number => s !== undefined);
    let speed: number;
    if (reported.length >= this.fixes.length / 2) {
      speed = reported.reduce((a, b) => a + b, 0) / reported.length;
    } else {
      let path = 0;
      for (let i = 1; i < this.fixes.length; i++) path += distanceM(this.fixes[i - 1]!.location, this.fixes[i]!.location);
      // Il rumore del GPS fa sembrare in movimento anche chi è fermo: si usa lo spostamento netto
      // quando è molto minore del percorso (oscillazione sul posto).
      const net = distanceM(first.location, last.location);
      speed = (net < path * 0.3 ? net : path) / (spanMs / 1000);
    }
    if (speed < this.stationaryBelow) return "stationary";
    if (speed > this.vehicleAbove) return "vehicle";
    return "walking";
  }
}
