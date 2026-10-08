import {
  formatNodeRef,
  resolveRef,
  type Audience,
  type Locale,
  type TerritoryPack,
  type UnitType,
} from "@guide/domain";

/**
 * Libreria narrativa di una destinazione: le unità del pack e delle sue
 * dipendenze, con tutti i riferimenti risolti in forma completa ("pack:slug").
 *
 * È costruita una volta (al caricamento del bundle) e usata dal planner a ogni tappa.
 */

export interface LibraryUnit {
  /** Riferimento completo dell'unità: "pack:slug". */
  ref: string;
  anchor: string;
  unitType: UnitType;
  locale: Locale;
  audience: Audience;
  durationS: number;
  text: string;
  /** Affermazioni usate, in forma completa. */
  assertions: string[];
  introduces: string[];
  requires: string[];
  hooks: { target: string; text: string }[];
  resumeHook?: string | undefined;
}

export interface NarrativeLibrary {
  destination: string;
  units: Map<string, LibraryUnit>;
  /** Unità per nodo di ancoraggio. */
  byAnchor: Map<string, LibraryUnit[]>;
  /** Unità che introducono un concetto, per lingua: `${locale}|${conceptRef}`. */
  introducers: Map<string, LibraryUnit[]>;
  /** Nome di ogni nodo per lingua (per i raccordi a modello). */
  labels: Map<string, Partial<Record<Locale, string>>>;
}

/** Pack raggiungibili da una destinazione (sé stessa più le dipendenze transitive). */
export function reachablePacks(destination: string, packs: ReadonlyMap<string, TerritoryPack>): TerritoryPack[] {
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    const pack = packs.get(id);
    if (!pack) return;
    seen.add(id);
    for (const dep of pack.manifest.dependsOn) visit(dep);
  };
  visit(destination);
  return [...seen].map((id) => packs.get(id)!);
}

export function buildLibrary(destination: string, packs: ReadonlyMap<string, TerritoryPack>): NarrativeLibrary {
  if (!packs.has(destination)) throw new Error(`destinazione sconosciuta: ${destination}`);
  const lib: NarrativeLibrary = {
    destination,
    units: new Map(),
    byAnchor: new Map(),
    introducers: new Map(),
    labels: new Map(),
  };

  for (const pack of reachablePacks(destination, packs)) {
    const packId = pack.manifest.id;
    const full = (raw: string) => {
      const parsed = resolveRef(raw, packId);
      if (!parsed) throw new Error(`riferimento non valido in ${packId}: ${raw}`);
      return formatNodeRef(parsed);
    };

    for (const item of [...pack.places, ...pack.nodes]) {
      const names: Partial<Record<Locale, string>> = {};
      for (const [loc, label] of Object.entries(item.labels)) if (label) names[loc as Locale] = label.name;
      lib.labels.set(formatNodeRef({ packId, slug: item.id }), names);
    }

    for (const u of pack.units) {
      const unit: LibraryUnit = {
        ref: formatNodeRef({ packId, slug: u.id }),
        anchor: full(u.anchor),
        unitType: u.unitType,
        locale: u.locale,
        audience: u.audience,
        durationS: u.durationS,
        text: u.text,
        assertions: u.assertions.map((a) => formatNodeRef({ packId, slug: a })),
        introduces: u.introduces.map(full),
        requires: u.requires.map(full),
        hooks: u.hooks.map((h) => ({ target: full(h.target), text: h.text })),
        resumeHook: u.resumeHook,
      };
      lib.units.set(unit.ref, unit);
      lib.byAnchor.set(unit.anchor, [...(lib.byAnchor.get(unit.anchor) ?? []), unit]);
      for (const concept of unit.introduces) {
        const key = `${unit.locale}|${concept}`;
        lib.introducers.set(key, [...(lib.introducers.get(key) ?? []), unit]);
      }
    }
  }
  return lib;
}
