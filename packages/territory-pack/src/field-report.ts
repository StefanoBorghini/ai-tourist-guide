/**
 * Revisione dei rilievi sul campo (file `guide-field-points/2` esportato dall'app).
 *
 * Produce PROPOSTE per luogo: posizione mediana dei rilievi GPS reali, scostamento dalle coordinate
 * del pack, raggio suggerito. Non scrive mai nel pack: la redazione decide e modifica i file a mano,
 * impostando poi coordinates.status: field_verified con data, autore e metodo.
 */
import { fieldPointsExportSchema, type FieldPointRecord, type TerritoryPack } from "@guide/domain";
import { metersBetween } from "./geo.ts";

export interface PlaceProposal {
  poiId: string;
  name: string;
  packLocation: [number, number];
  packRadiusM: number | null;
  /** Rilievi GPS reali di posizione usati per la proposta. */
  positions: number;
  bestAccuracyM: number | null;
  /** [lng, lat] mediana dei rilievi di posizione (null se nessun rilievo di posizione). */
  proposedLocation: [number, number] | null;
  offsetM: number | null;
  /** Dai rilievi di bordo (distanza dal centro proposto) o dai raggi suggeriti. */
  proposedRadiusM: number | null;
  notes: string[];
  warnings: string[];
}

export interface FieldReport {
  destination: string;
  totalPoints: number;
  simulatedIgnored: number;
  unknownPlaces: string[];
  freeNotes: { lat: number; lon: number; note: string | null }[];
  places: PlaceProposal[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const round7 = (n: number) => Math.round(n * 1e7) / 1e7;

/** Precisione oltre la quale un rilievo non basta da solo a verificare una coordinata. */
export const MAX_RELIABLE_ACCURACY_M = 15;

export function fieldReport(raw: unknown, pack: TerritoryPack): FieldReport {
  const data = fieldPointsExportSchema.parse(raw);
  const real = data.points.filter((p) => p.position_source === "gps");
  const byPoi = new Map<string, FieldPointRecord[]>();
  const unknown = new Set<string>();
  for (const p of real) {
    if (!p.poi_id) continue;
    if (!pack.places.some((pl) => pl.id === p.poi_id)) {
      unknown.add(p.poi_id);
      continue;
    }
    byPoi.set(p.poi_id, [...(byPoi.get(p.poi_id) ?? []), p]);
  }

  const places: PlaceProposal[] = [];
  for (const place of pack.places) {
    const points = byPoi.get(place.id);
    if (!points) continue;
    const positions = points.filter((p) => p.kind === "poi_position");
    const edges = points.filter((p) => p.kind === "geofence_edge");
    const proposed: [number, number] | null =
      positions.length > 0 ? [round7(median(positions.map((p) => p.lon))), round7(median(positions.map((p) => p.lat)))] : null;
    const center = proposed ?? place.location;
    const edgeRadius = edges.length > 0 ? Math.max(...edges.map((e) => metersBetween(center, [e.lon, e.lat]))) : null;
    const suggested = points.flatMap((p) => (p.geofence_radius_suggested_m ? [p.geofence_radius_suggested_m] : []));
    const radius = edgeRadius !== null ? Math.round(edgeRadius / 5) * 5 || 5 : suggested.length > 0 ? Math.round(median(suggested)) : null;
    const best = positions.length > 0 ? Math.min(...positions.map((p) => p.accuracy_m)) : null;
    const warnings: string[] = [];
    if (positions.length === 0) warnings.push("nessun rilievo di posizione: coordinate non proponibili");
    if (positions.length === 1) warnings.push("un solo rilievo di posizione: meglio ripeterlo");
    if (best !== null && best > MAX_RELIABLE_ACCURACY_M) warnings.push(`precisione migliore ±${best} m: insufficiente per verificare`);
    if (positions.length > 1 && proposed) {
      const spread = Math.max(...positions.map((p) => metersBetween(proposed, [p.lon, p.lat])));
      if (spread > 25) warnings.push(`rilievi distanti fino a ${Math.round(spread)} m tra loro: controllare`);
    }
    places.push({
      poiId: place.id,
      name: place.labels[pack.manifest.defaultLocale]?.name ?? place.id,
      packLocation: [place.location[0], place.location[1]],
      packRadiusM: place.geofences.find((g) => g.kind === "arrival")?.radiusM ?? null,
      positions: positions.length,
      bestAccuracyM: best,
      proposedLocation: proposed,
      offsetM: proposed ? Math.round(metersBetween(place.location, proposed)) : null,
      proposedRadiusM: radius,
      notes: points.flatMap((p) => (p.note ? [p.note] : [])),
      warnings,
    });
  }

  return {
    destination: data.destination,
    totalPoints: data.points.length,
    simulatedIgnored: data.points.length - real.length,
    unknownPlaces: [...unknown].sort(),
    freeNotes: real.filter((p) => !p.poi_id).map((p) => ({ lat: p.lat, lon: p.lon, note: p.note })),
    places,
  };
}
