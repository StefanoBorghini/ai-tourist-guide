/**
 * Rilievi sul campo: posizioni reali dei luoghi registrate in modalità debug.
 *
 * Restano nel browser del telefono (localStorage) finché non vengono esportati in un file JSON
 * (formato `guide-field-points/2`, schema in @guide/domain). Il file non modifica il pack:
 * si rivede con `guide-pack field` e solo dopo si aggiornano coordinate e raggi.
 */
import type { BundleContent } from "@guide/bundle/client";
import { distanceM, type Fix } from "@guide/context-engine";
import {
  FIELD_POINTS_FORMAT,
  fieldPointsExportSchema,
  type FieldPointKind,
  type FieldPointRecord,
  type FieldPointsExport,
} from "@guide/domain";

export type PositionSource = "gps" | "simulated";

const key = (destination: string) => `${FIELD_POINTS_FORMAT}:${destination}`;
const round7 = (n: number) => Math.round(n * 1e7) / 1e7;

/** Costruisce un rilievo dalla posizione attuale (logica pura, testata). */
export function buildFieldPoint(input: {
  content: BundleContent;
  placeRef: string | null;
  kind: FieldPointKind;
  fix: Fix;
  source: PositionSource;
  note?: string;
  suggestedRadiusM?: number | null;
  device?: string | null;
  now?: number;
}): FieldPointRecord {
  const { content, placeRef, fix } = input;
  const place = placeRef ? content.places.find((p) => p.ref === placeRef) : undefined;
  const arrival = place?.geofences.find((g) => g.kind === "arrival");
  return {
    poi_id: place ? place.ref.slice(place.ref.indexOf(":") + 1) : null,
    poi_ref: place?.ref ?? null,
    kind: input.kind,
    lat: round7(fix.location[1]),
    lon: round7(fix.location[0]),
    accuracy_m: Math.round(fix.accuracyM * 10) / 10,
    geofence_radius_pack_m: arrival?.radiusM ?? null,
    geofence_radius_suggested_m: input.suggestedRadiusM && input.suggestedRadiusM > 0 ? input.suggestedRadiusM : null,
    distance_from_pack_m: place ? Math.round(distanceM(fix.location, place.location)) : null,
    pack_coordinate_status: place?.coordinateStatus ?? null,
    recorded_at: new Date(input.now ?? Date.now()).toISOString(),
    position_at: new Date(fix.timestamp).toISOString(),
    device: input.device ?? null,
    position_source: input.source,
    note: input.note?.trim() ? input.note.trim() : null,
  };
}

export function fieldPointsExport(
  destination: string,
  bundleHash: string | null,
  points: FieldPointRecord[],
  device: string | null,
  now = new Date(),
): FieldPointsExport {
  // parse: un file che non rispetta lo schema non deve mai uscire dall'app.
  return fieldPointsExportSchema.parse({
    format: FIELD_POINTS_FORMAT,
    destination,
    bundle_hash: bundleHash,
    exported_at: now.toISOString(),
    device,
    review_required: true,
    points,
  });
}

export function loadFieldPoints(destination: string): FieldPointRecord[] {
  try {
    const raw = localStorage.getItem(key(destination));
    return raw ? (JSON.parse(raw) as FieldPointRecord[]) : [];
  } catch {
    return [];
  }
}

function save(destination: string, points: FieldPointRecord[]): FieldPointRecord[] {
  try {
    localStorage.setItem(key(destination), JSON.stringify(points));
  } catch {
    // Memoria non disponibile (navigazione privata): i rilievi restano solo in questa sessione.
  }
  return points;
}

export function addFieldPoint(destination: string, point: FieldPointRecord): FieldPointRecord[] {
  return save(destination, [...loadFieldPoints(destination), point]);
}

export function removeFieldPoint(destination: string, index: number): FieldPointRecord[] {
  return save(destination, loadFieldPoints(destination).filter((_, i) => i !== index));
}

function exportFile(data: FieldPointsExport): File {
  const name = `rilievi-${data.destination}-${data.exported_at.slice(0, 16).replace(/[:T]/g, "-")}.json`;
  return new File([JSON.stringify(data, null, 2)], name, { type: "application/json" });
}

/** Scarica i rilievi come file JSON. */
export function downloadFieldPoints(data: FieldPointsExport): void {
  const file = exportFile(data);
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Condivide il file (WhatsApp, e-mail, Drive…) dove il telefono lo permette. */
export async function shareFieldPoints(data: FieldPointsExport): Promise<boolean> {
  const file = exportFile(data);
  if (typeof navigator === "undefined" || !navigator.canShare?.({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file], title: file.name });
    return true;
  } catch {
    return false; // annullato dall'utente
  }
}
