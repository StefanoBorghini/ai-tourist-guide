/**
 * Diritti → parti a pagamento di un bundle (BuiltBundle.premium) che un utente può ricevere.
 * Stesse regole delle funzioni del database (20261024000000_entitlements.sql, can_access_explore/can_access_route):
 * - «explore» sulla destinazione dà solo l'esplorazione completa, nessun percorso premium;
 * - «route» dà solo quel percorso (un pacchetto diventa un diritto «route» per ciascuno dei suoi percorsi);
 * - «place» dà solo quel luogo (20261028000000_place_products.sql, has_place_right);
 * - «unit» dà solo quel contenuto singolo; «all» l'esplorazione completa di ogni destinazione
 *   (20261107000000_progressive_purchase.sql, has_unit_right). Chi ha il luogo o l'esplorazione riceve gli stessi
 *   racconti dalle loro parti: nessuna parte «unit» doppia.
 * Non decide chi ha quali diritti: li riceve già verificati dal server.
 */
import type { PremiumPart } from "./format.ts";

export type Right =
  | { scope: "explore"; destination: string }
  | { scope: "route"; route: string }
  | { scope: "place"; place: string }
  | { scope: "unit"; place: string }
  | { scope: "all" };

export function allowedPremiumParts(destination: string, parts: readonly PremiumPart[], rights: readonly Right[]): PremiumPart[] {
  const explore = rights.some((r) => (r.scope === "explore" && r.destination === destination) || r.scope === "all");
  const routes = new Set(rights.flatMap((r) => (r.scope === "route" ? [r.route] : [])));
  const places = new Set(rights.flatMap((r) => (r.scope === "place" ? [r.place] : [])));
  const units = new Set(rights.flatMap((r) => (r.scope === "unit" ? [r.place] : [])));
  return parts.filter((p) => {
    if (p.kind === "explore") return explore;
    if (p.ref === undefined) return false;
    if (p.kind === "route") return routes.has(p.ref);
    if (p.kind === "unit") return units.has(p.ref);
    return places.has(p.ref);
  });
}

/**
 * Racconti propri del luogo in una parte «unit» e, fra questi, quelli con tutte le affermazioni verificate (nessuna
 * marcata inReview, almeno una affermazione). La pubblicazione li scrive nel manifest: il database vende un contenuto
 * singolo solo se ha almeno un racconto verificato (criterio rigoroso, migrazione 20261107000000).
 */
export function unitStoryCounts(part: PremiumPart): { stories: number; verifiedStories: number } {
  const assertions = new Map(part.assertions.map((a) => [a.ref, a]));
  const own = part.units.filter((u) => u.anchor === part.ref);
  const verified = own.filter(
    (u) => u.assertions.length > 0 && u.assertions.every((ref) => assertions.has(ref) && !assertions.get(ref)!.inReview),
  );
  return { stories: own.length, verifiedStories: verified.length };
}
