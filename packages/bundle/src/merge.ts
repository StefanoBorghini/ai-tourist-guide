/**
 * Unione dei contenuti acquistati (parti a pagamento, già verificate con la loro impronta) con il bundle pubblico,
 * sul dispositivo. Pura e deterministica: lo stesso bundle con le stesse parti dà sempre lo stesso contenuto.
 *
 * Regola (decisione del 2026-10-18): i racconti di un percorso acquistato valgono in tutta la guida, anche
 * nell'esplorazione libera, non solo dentro il percorso. Così chi ha comprato un percorso ritrova quei luoghi
 * sbloccati quando esplora, e un acquisto successivo dell'esplorazione non gli ridà gli stessi racconti come nuovi.
 * Un luogo principale comprato (parte "place") porta i suoi racconti e quelli dei suoi sottoluoghi: l'esplorazione
 * resta bloccata, quei luoghi no.
 */
import type { BundleContent, PremiumPart } from "./format.ts";

const byRef = <T extends { ref: string }>(a: T, b: T) => a.ref.localeCompare(b.ref);

function union<T extends { ref: string }>(base: readonly T[], extra: readonly T[]): T[] {
  const all = new Map(base.map((x) => [x.ref, x]));
  for (const x of extra) if (!all.has(x.ref)) all.set(x.ref, x);
  return [...all.values()].sort(byRef);
}

export function mergePremium(content: BundleContent, parts: readonly PremiumPart[]): BundleContent {
  if (parts.length === 0) return content;
  const units = union(content.units, parts.flatMap((p) => p.units));
  const assertions = union(content.assertions, parts.flatMap((p) => p.assertions));
  const sources = union(content.sources, parts.flatMap((p) => p.sources));
  const routes = union(content.routes, parts.flatMap((p) => p.routes));
  const owned = new Set(parts.flatMap((p) => (p.kind === "route" && p.ref ? [p.ref] : [])));
  const explore = (content.locked?.explore ?? false) && !parts.some((p) => p.kind === "explore");
  const lockedRoutes = (content.locked?.routes ?? []).filter((r) => !owned.has(r.ref));
  // Luoghi sbloccati dagli acquisti: i luoghi principali comprati con i loro sottoluoghi (partOf), e le tappe dei
  // percorsi comprati.
  const subPlaces = (ref: string) => content.places.filter((pl) => pl.partOf === ref).map((pl) => pl.ref);
  const ownedPlaces = new Set(
    parts.flatMap((p) =>
      p.kind === "place" && p.ref ? [p.ref, ...subPlaces(p.ref)] : p.kind === "route" ? p.routes.flatMap((r) => r.stops.map((s) => s.place)) : [],
    ),
  );
  const lockedPlaces = content.locked?.places?.filter((ref) => !ownedPlaces.has(ref));
  const { locked: _locked, ...rest } = content;
  return {
    ...rest,
    units,
    assertions,
    sources,
    routes,
    ...(explore || lockedRoutes.length > 0
      ? { locked: { explore, routes: lockedRoutes, ...(explore && lockedPlaces ? { places: lockedPlaces } : {}) } }
      : {}),
  };
}
