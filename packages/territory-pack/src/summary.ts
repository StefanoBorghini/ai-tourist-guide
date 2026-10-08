import type { TerritoryPack } from "@guide/domain";

export interface PackSummary {
  id: string;
  kind: string;
  version: string;
  fictional: boolean;
  places: number;
  nodes: number;
  sources: number;
  assertions: { total: number; verified: number };
  unitsByLocale: Record<string, number>;
  routes: number;
}

export function summarizePack(pack: TerritoryPack): PackSummary {
  const unitsByLocale: Record<string, number> = {};
  for (const u of pack.units) unitsByLocale[u.locale] = (unitsByLocale[u.locale] ?? 0) + 1;
  return {
    id: pack.manifest.id,
    kind: pack.manifest.kind,
    version: pack.manifest.version,
    fictional: pack.manifest.fictional,
    places: pack.places.length,
    nodes: pack.nodes.length,
    sources: pack.sources.length,
    assertions: {
      total: pack.assertions.length,
      verified: pack.assertions.filter((a) => a.status === "verified").length,
    },
    unitsByLocale,
    routes: pack.routes.length,
  };
}
