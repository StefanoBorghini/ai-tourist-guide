import type { TerritoryPack } from "@guide/domain";
import type { FenceDefinition } from "./geofence.ts";
import type { AnchorTarget, Candidate } from "./planner.ts";
import type { ContextPlace } from "./snapshot.ts";

/**
 * Converte un Territory Pack negli input del motore di contesto.
 * È l'unico punto in cui il motore conosce il formato del pack.
 */

export interface EngineInputs {
  places: (ContextPlace & Candidate)[];
  fences: FenceDefinition[];
  anchors: Omit<AnchorTarget, "deadline">[];
}

export function engineInputsFromPack(pack: TerritoryPack): EngineInputs {
  const places = pack.places.map((p) => ({
    id: p.id,
    location: p.location,
    elevationM: p.elevationM,
    importance: p.importance,
    dwellMin: p.dwellMin,
    tags: p.categories,
    stepFree: p.accessibility?.stepFree,
    stairs: p.accessibility?.stairs,
  }));

  const fences: FenceDefinition[] = pack.places.flatMap((p) =>
    p.geofences.map((g, i) => ({
      id: `${p.id}#${g.kind}#${i}`,
      placeId: p.id,
      kind: g.kind,
      center: g.center ?? p.location,
      radiusM: g.radiusM,
      minDwellS: g.minDwellS,
      maxAccuracyM: g.maxAccuracyM,
      viewBearingDeg: g.viewBearingDeg,
      viewToleranceDeg: g.viewToleranceDeg,
    })),
  );

  const anchors = pack.anchors.map((a) => ({
    id: a.id,
    location: a.location,
    safetyMarginMin: a.safetyMarginMin,
  }));

  return { places, fences, anchors };
}
