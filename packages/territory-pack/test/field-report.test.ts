import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIELD_POINTS_FORMAT, type FieldPointRecord } from "@guide/domain";
import { describe, expect, it } from "vitest";
import { fieldReport } from "../src/field-report.ts";
import { loadPacks } from "../src/load.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { packs } = loadPacks(resolve(here, "../../../territories/_synthetic"));
const pack = [...packs.values()].find((p) => p.manifest.kind === "destination")!;
const place = pack.places[0]!;

const point = (over: Partial<FieldPointRecord>): FieldPointRecord => ({
  poi_id: place.id,
  poi_ref: `${pack.manifest.id}:${place.id}`,
  kind: "poi_position",
  lat: place.location[1] + 0.0009,
  lon: place.location[0],
  accuracy_m: 5,
  geofence_radius_pack_m: 25,
  geofence_radius_suggested_m: null,
  distance_from_pack_m: 100,
  pack_coordinate_status: "preliminary",
  recorded_at: "2026-10-10T09:00:00.000Z",
  position_at: "2026-10-10T09:00:00.000Z",
  device: null,
  position_source: "gps",
  note: null,
  ...over,
});
const file = (points: FieldPointRecord[]) => ({
  format: FIELD_POINTS_FORMAT,
  destination: pack.manifest.id,
  bundle_hash: null,
  exported_at: "2026-10-10T10:00:00.000Z",
  device: null,
  review_required: true,
  points,
});

describe("revisione dei rilievi", () => {
  it("propone la posizione mediana dei rilievi reali e ignora quelli simulati", () => {
    const r = fieldReport(
      file([
        point({}),
        point({ lat: place.location[1] + 0.00092 }),
        point({ lat: place.location[1] + 0.00088 }),
        point({ lat: 10, lon: 10, position_source: "simulated" }),
      ]),
      pack,
    );
    expect(r.simulatedIgnored).toBe(1);
    const p = r.places[0]!;
    expect(p.positions).toBe(3);
    expect(p.offsetM).toBeGreaterThan(90);
    expect(p.offsetM).toBeLessThan(110);
    expect(p.warnings).toEqual([]);
  });

  it("propone il raggio dai rilievi di bordo e segnala rilievi poco affidabili", () => {
    const r = fieldReport(
      file([point({ accuracy_m: 30 }), point({ kind: "geofence_edge", lat: place.location[1] + 0.0009 + 0.0003, note: "qui si vede il portale" })]),
      pack,
    );
    const p = r.places[0]!;
    expect(p.proposedRadiusM).toBeGreaterThanOrEqual(30);
    expect(p.proposedRadiusM).toBeLessThanOrEqual(35);
    expect(p.warnings.join(" ")).toMatch(/un solo rilievo/);
    expect(p.warnings.join(" ")).toMatch(/insufficiente/);
    expect(p.notes).toEqual(["qui si vede il portale"]);
  });

  it("rifiuta un file non valido", () => {
    expect(() => fieldReport({ ...file([]), review_required: false }, pack)).toThrow();
  });
});
