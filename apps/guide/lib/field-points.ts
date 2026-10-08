/**
 * Rilievi sul campo: posizioni reali dei luoghi registrate in modalità debug.
 *
 * Restano nel browser del telefono (localStorage) finché non vengono esportati in un file JSON,
 * che la redazione usa per aggiornare le coordinate del Territory Pack (stato field_verified).
 */

export const FIELD_POINTS_FORMAT = "guide-field-points/1";

export interface FieldPoint {
  /** Luogo rilevato (riferimento completo), oppure null per una nota libera con posizione. */
  placeRef: string | null;
  /** [longitudine, latitudine] */
  location: [number, number];
  accuracyM: number;
  timestamp: number;
  note?: string;
}

export interface FieldPointsExport {
  format: typeof FIELD_POINTS_FORMAT;
  destination: string;
  exportedAt: string;
  points: (FieldPoint & { recordedAt: string })[];
}

const key = (destination: string) => `guide-field-points:${destination}`;

export function loadFieldPoints(destination: string): FieldPoint[] {
  try {
    const raw = localStorage.getItem(key(destination));
    return raw ? (JSON.parse(raw) as FieldPoint[]) : [];
  } catch {
    return [];
  }
}

function save(destination: string, points: FieldPoint[]): FieldPoint[] {
  try {
    localStorage.setItem(key(destination), JSON.stringify(points));
  } catch {
    // Memoria non disponibile (navigazione privata): i rilievi restano solo in questa sessione.
  }
  return points;
}

export function addFieldPoint(destination: string, point: FieldPoint): FieldPoint[] {
  return save(destination, [...loadFieldPoints(destination), point]);
}

export function removeFieldPoint(destination: string, index: number): FieldPoint[] {
  return save(destination, loadFieldPoints(destination).filter((_, i) => i !== index));
}

export function fieldPointsExport(destination: string, points: FieldPoint[], now = new Date()): FieldPointsExport {
  return {
    format: FIELD_POINTS_FORMAT,
    destination,
    exportedAt: now.toISOString(),
    points: points.map((p) => ({ ...p, recordedAt: new Date(p.timestamp).toISOString() })),
  };
}

/** Scarica i rilievi come file JSON. */
export function exportFieldPoints(destination: string, points: FieldPoint[]): void {
  const data = fieldPointsExport(destination, points);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `rilievi-${destination}-${data.exportedAt.slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
