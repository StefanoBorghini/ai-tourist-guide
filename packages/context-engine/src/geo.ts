/**
 * Geometria sulla sfera terrestre. Coordinate sempre [longitudine, latitudine]
 * come nei Territory Pack e in GeoJSON.
 */

export type LngLat = readonly [lng: number, lat: number];

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Distanza in metri (formula dell'emisenoverso). */
export function distanceM(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Direzione iniziale da a verso b, in gradi da nord (0–360). */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const φ1 = toRad(a[1]);
  const φ2 = toRad(b[1]);
  const Δλ = toRad(b[0] - a[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Differenza angolare minima tra due direzioni (0–180). */
export function angleDiffDeg(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/** Punto a `distance` metri da `origin` nella direzione `bearing` (utile per test e simulazioni). */
export function destination(origin: LngLat, bearing: number, distance: number): LngLat {
  const δ = distance / EARTH_RADIUS_M;
  const θ = toRad(bearing);
  const φ1 = toRad(origin[1]);
  const λ1 = toRad(origin[0]);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [toDeg(λ2), toDeg(φ2)];
}

export type RelativeDirection = "ahead" | "right" | "behind" | "left";

/** Dove si trova un punto rispetto alla direzione in cui si guarda. */
export function relativeDirection(headingDeg: number, targetBearingDeg: number): RelativeDirection {
  const rel = (((targetBearingDeg - headingDeg) % 360) + 360) % 360;
  if (rel < 45 || rel >= 315) return "ahead";
  if (rel < 135) return "right";
  if (rel < 225) return "behind";
  return "left";
}
