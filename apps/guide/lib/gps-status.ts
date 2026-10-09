/**
 * Stato del segnale di posizione, da mostrare a chi cammina: logica pura, testata.
 *
 * Il browser non avvisa quando il GPS smette di aggiornarsi (galleria, carrugi stretti, app in
 * secondo piano): l'età dell'ultima posizione è l'unico indizio, quindi si controlla qui.
 */
import type { Fix } from "@guide/context-engine";
import type { PositionSource } from "./field-points";

export type GpsErrorCode = "denied" | "unavailable" | "timeout" | "no_signal";
export type GpsLevel = "off" | "waiting" | "ok" | "imprecise" | "stale" | "no_signal" | "denied" | "unavailable" | "simulated";

/** Oltre questa precisione i geofence ignorano la posizione (stesso limite dei geofence predefiniti). */
export const GPS_IMPRECISE_M = 35;
/**
 * Senza posizioni nuove da così tanto, il segnale è da considerare debole o assente. Con l'alta
 * precisione i telefoni aggiornano di norma ogni pochi secondi anche da fermi; il margine è ampio
 * per non allarmare chi è solo fermo a guardare.
 */
export const GPS_STALE_MS = 45_000;

export interface GpsStatus {
  level: GpsLevel;
  accuracyM: number | null;
  ageS: number | null;
}

export function gpsStatus(input: {
  watching: boolean;
  simulating: boolean;
  error: GpsErrorCode | null;
  fix: Fix | null;
  source: PositionSource | null;
  now: number;
}): GpsStatus {
  const { watching, simulating, error, fix, source, now } = input;
  const accuracyM = fix ? Math.round(fix.accuracyM) : null;
  const ageS = fix ? Math.max(0, Math.round((now - fix.timestamp) / 1000)) : null;
  const status = (level: GpsLevel): GpsStatus => ({ level, accuracyM, ageS });
  if (simulating || (!watching && source === "simulated" && fix)) return status("simulated");
  if (error === "denied" || error === "unavailable") return status(error);
  if (!watching) return status("off");
  if (!fix || source !== "gps") return status(error ? "no_signal" : "waiting");
  if (now - fix.timestamp > GPS_STALE_MS) return status("stale");
  if (fix.accuracyM > GPS_IMPRECISE_M) return status("imprecise");
  return status("ok");
}
