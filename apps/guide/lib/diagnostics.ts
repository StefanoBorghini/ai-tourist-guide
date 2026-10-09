/**
 * Diagnostica del bundle per la modalità debug: logica pura, testata.
 */
import type { BundleContent } from "@guide/bundle/client";
import { distanceM } from "@guide/context-engine";

export interface FenceOverlap {
  a: string;
  b: string;
  distanceM: number;
  radiusA: number;
  radiusB: number;
}

/** Coppie di luoghi i cui geofence di arrivo si sovrappongono (possono scattare insieme). */
export function fenceOverlaps(content: BundleContent): FenceOverlap[] {
  const fences = content.places.flatMap((p) =>
    p.geofences.filter((g) => g.kind === "arrival").map((g) => ({ ref: p.ref, center: g.center, r: g.radiusM })),
  );
  const out: FenceOverlap[] = [];
  for (let i = 0; i < fences.length; i++) {
    for (let j = i + 1; j < fences.length; j++) {
      const a = fences[i]!;
      const b = fences[j]!;
      if (a.ref === b.ref) continue;
      const d = distanceM(a.center, b.center);
      if (d < a.r + b.r) out.push({ a: a.ref, b: b.ref, distanceM: Math.round(d), radiusA: a.r, radiusB: b.r });
    }
  }
  return out.sort((x, y) => x.distanceM - y.distanceM);
}

/** Stato delle informazioni storiche di un luogo: affermazioni verificate, in revisione, unità raccontabili. */
export function placeKnowledge(content: BundleContent, placeRef: string) {
  const units = content.units.filter((u) => u.anchor === placeRef);
  // Affermazioni sul luogo e quelle citate dai suoi racconti (es. una leggenda è un nodo a sé).
  const cited = new Set(units.flatMap((u) => u.assertions));
  const about = content.assertions.filter((a) => a.subject === placeRef || cited.has(a.ref));
  return {
    verified: about.filter((a) => !a.inReview).length,
    inReview: about.filter((a) => a.inReview).length,
    sourceUnconfirmed: about.filter((a) => a.sourceUnconfirmed).length,
    types: [...new Set(about.map((a) => a.type))].sort(),
    units: units.length,
  };
}
