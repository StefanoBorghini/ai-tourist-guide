import { distanceM, type LngLat } from "./geo.ts";

/**
 * Stima dei tempi di cammino.
 *
 * In assenza di un grafo pedonale reale si usa la distanza in linea d'aria
 * moltiplicata per un fattore di deviazione (le strade non sono rette) e la
 * funzione di Tobler per tenere conto della pendenza: in un borgo con scalinate
 * e un castello in cima la differenza è grande.
 *
 * L'interfaccia permette di sostituire la stima con un grafo pedonale per zona
 * (tabella walk_edges) senza toccare il pianificatore.
 */

export interface Point {
  location: LngLat;
  elevationM?: number | undefined;
}

export interface WalkEstimator {
  /** Secondi di cammino da a verso b. */
  seconds(a: Point, b: Point): number;
}

export interface ToblerOptions {
  /** Fattore di deviazione rispetto alla linea d'aria. */
  detourFactor?: number;
  /** Moltiplicatore del passo personale: 1 = passo medio, 1.3 = più lento. */
  paceFactor?: number;
}

/** Velocità in km/h secondo Tobler, data la pendenza (dislivello / distanza). */
export function toblerSpeedKmh(slope: number): number {
  return 6 * Math.exp(-3.5 * Math.abs(slope + 0.05));
}

export function toblerEstimator(options: ToblerOptions = {}): WalkEstimator {
  const detour = options.detourFactor ?? 1.3;
  const pace = options.paceFactor ?? 1;
  return {
    seconds(a, b) {
      const horizontal = distanceM(a.location, b.location) * detour;
      if (horizontal < 1) return 0;
      const climb = (b.elevationM ?? 0) - (a.elevationM ?? 0);
      const speedMs = (toblerSpeedKmh(climb / horizontal) * 1000) / 3600;
      return (horizontal / speedMs) * pace;
    },
  };
}
