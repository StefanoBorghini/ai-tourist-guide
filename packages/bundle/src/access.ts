/**
 * Diritti → parti a pagamento di un bundle (BuiltBundle.premium) che un utente può ricevere.
 * Stesse regole delle funzioni del database (20261024000000_entitlements.sql, can_access_explore/can_access_route):
 * - «explore» sulla destinazione dà solo l'esplorazione completa, nessun percorso premium;
 * - «route» dà solo quel percorso (un pacchetto diventa un diritto «route» per ciascuno dei suoi percorsi);
 * - «place» dà solo quel luogo (20261028000000_place_products.sql, has_place_right).
 * Non decide chi ha quali diritti: li riceve già verificati dal server.
 */
import type { PremiumPart } from "./format.ts";

export type Right =
  | { scope: "explore"; destination: string }
  | { scope: "route"; route: string }
  | { scope: "place"; place: string };

export function allowedPremiumParts(destination: string, parts: readonly PremiumPart[], rights: readonly Right[]): PremiumPart[] {
  const explore = rights.some((r) => r.scope === "explore" && r.destination === destination);
  const routes = new Set(rights.flatMap((r) => (r.scope === "route" ? [r.route] : [])));
  const places = new Set(rights.flatMap((r) => (r.scope === "place" ? [r.place] : [])));
  return parts.filter((p) =>
    p.kind === "explore" ? explore : p.ref !== undefined && (p.kind === "route" ? routes : places).has(p.ref),
  );
}
