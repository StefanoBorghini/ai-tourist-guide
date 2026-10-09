import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundle, type BundleContent } from "@guide/bundle";
import { fieldPointsExportSchema } from "@guide/domain";
import { loadPacks } from "@guide/territory-pack";
import { beforeAll, describe, expect, it } from "vitest";
import { fenceOverlaps, placeKnowledge } from "../lib/diagnostics.ts";
import { buildFieldPoint, fieldPointsExport } from "../lib/field-points.ts";

/** Prove sul bundle del territorio di test, senza nomi di territorio scritti qui. */
const here = dirname(fileURLToPath(import.meta.url));
let content: BundleContent;

beforeAll(() => {
  const { packs } = loadPacks(resolve(here, "../../../territories/_synthetic"));
  const dest = [...packs.values()].find((p) => p.manifest.kind === "destination")!;
  content = buildBundle(packs, { destination: dest.manifest.id, locale: "it", allowFictional: true }).content;
});

describe("rilievi sul campo", () => {
  const fix = (lng: number, lat: number) => ({ location: [lng, lat] as [number, number], accuracyM: 6.4, timestamp: Date.UTC(2026, 9, 10, 9, 30) });

  it("un rilievo contiene luogo, posizione, precisione, distanza dal pack, origine e nota", () => {
    const place = content.places[0]!;
    const p = buildFieldPoint({
      content,
      placeRef: place.ref,
      kind: "poi_position",
      fix: fix(place.location[0] + 0.0002, place.location[1]),
      source: "gps",
      note: "  davanti al portale  ",
      suggestedRadiusM: 30,
      device: "test",
      now: Date.UTC(2026, 9, 10, 9, 31),
    });
    expect(p.poi_id).toBe(place.ref.split(":")[1]);
    expect(p.position_source).toBe("gps");
    expect(p.note).toBe("davanti al portale");
    expect(p.geofence_radius_suggested_m).toBe(30);
    expect(p.distance_from_pack_m).toBeGreaterThan(15);
    expect(p.distance_from_pack_m).toBeLessThan(30);
    expect(p.position_at).toBe("2026-10-10T09:30:00.000Z");
    expect(p.recorded_at).toBe("2026-10-10T09:31:00.000Z");
  });

  it("l'esportazione è JSON valido secondo lo schema e distingue i punti simulati", () => {
    const points = [
      buildFieldPoint({ content, placeRef: content.places[0]!.ref, kind: "poi_position", fix: fix(0.001, 0.001), source: "gps" }),
      buildFieldPoint({ content, placeRef: null, kind: "note", fix: fix(0.002, 0.002), source: "simulated", note: "prova" }),
    ];
    const data = fieldPointsExport(content.destination, "abc", points, "test");
    const reparsed = fieldPointsExportSchema.parse(JSON.parse(JSON.stringify(data)));
    expect(reparsed.review_required).toBe(true);
    expect(reparsed.points.map((p) => p.position_source)).toEqual(["gps", "simulated"]);
    expect(reparsed.points[1]!.poi_id).toBeNull();
  });
});

describe("diagnostica", () => {
  it("trova i geofence sovrapposti", () => {
    const copy = structuredClone(content);
    const [a, b] = copy.places;
    a!.geofences = [{ kind: "arrival", center: a!.location, radiusM: 50, minDwellS: 8, maxAccuracyM: 35 }];
    b!.geofences = [{ kind: "arrival", center: [a!.location[0], a!.location[1] + 0.0003], radiusM: 50, minDwellS: 8, maxAccuracyM: 35 }];
    const ov = fenceOverlaps(copy);
    expect(ov.some((o) => [o.a, o.b].includes(a!.ref) && [o.a, o.b].includes(b!.ref))).toBe(true);
  });

  it("riassume le informazioni storiche di un luogo", () => {
    const place = content.places.find((p) => content.units.some((u) => u.anchor === p.ref))!;
    const k = placeKnowledge(content, place.ref);
    expect(k.units).toBeGreaterThan(0);
    expect(k.verified + k.inReview).toBeGreaterThan(0);
  });
});
