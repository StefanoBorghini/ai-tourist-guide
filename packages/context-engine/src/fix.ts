import type { LngLat } from "./geo.ts";

/** Una posizione ricevuta dal GPS. */
export interface Fix {
  location: LngLat;
  /** Raggio di incertezza in metri (68%), come lo fornisce il sistema operativo. */
  accuracyM: number;
  /** Millisecondi dall'epoca. */
  timestamp: number;
  /** Velocità in m/s, se fornita dal sistema. */
  speedMs?: number | undefined;
  /** Direzione dello sguardo dalla bussola, in gradi da nord. */
  compassDeg?: number | undefined;
}
