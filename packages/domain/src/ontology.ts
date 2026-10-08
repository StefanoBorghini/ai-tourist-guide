import type { NodeKind } from "./vocabulary.ts";

/**
 * Ontologia dei predicati (v1).
 *
 * - relation: collega due nodi (soggetto → oggetto), es. persona "visited" luogo.
 * - value: attributo strutturato del soggetto (anni, misure), verificabile dal validatore.
 * - statement: affermazione testuale sul soggetto, senza valore strutturato.
 *
 * Ogni predicato dichiara i tipi di nodo ammessi come soggetto (domain) e,
 * per le relazioni, come oggetto (range).
 */

export type PredicateKind = "relation" | "value" | "statement";
export type ValueShape = "year_range" | "measure";

export interface PredicateDefinition {
  id: string;
  kind: PredicateKind;
  domain: readonly NodeKind[] | "any";
  range?: readonly NodeKind[] | "any";
  value?: ValueShape;
  labels: { it: string; en: string };
}

const ANY = "any" as const;

export const PREDICATES = [
  // Relazioni
  { id: "part_of", kind: "relation", domain: ["place"], range: ["place", "territory"], labels: { it: "fa parte di", en: "is part of" } },
  { id: "located_in", kind: "relation", domain: ["place", "territory"], range: ["territory"], labels: { it: "si trova in", en: "is located in" } },
  { id: "built_by", kind: "relation", domain: ["place", "work"], range: ["person", "organization"], labels: { it: "costruito da", en: "built by" } },
  { id: "commissioned_by", kind: "relation", domain: ["place", "work"], range: ["person", "organization"], labels: { it: "commissionato da", en: "commissioned by" } },
  { id: "visited", kind: "relation", domain: ["person"], range: ["place", "territory"], labels: { it: "visitò", en: "visited" } },
  { id: "lived_in", kind: "relation", domain: ["person"], range: ["place", "territory"], labels: { it: "visse a", en: "lived in" } },
  { id: "created", kind: "relation", domain: ["person", "organization"], range: ["work"], labels: { it: "creò", en: "created" } },
  { id: "depicts", kind: "relation", domain: ["work"], range: ["person", "event", "place", "territory", "legend"], labels: { it: "raffigura", en: "depicts" } },
  { id: "occurred_at", kind: "relation", domain: ["event"], range: ["place", "territory"], labels: { it: "avvenne a", en: "took place at" } },
  { id: "participated_in", kind: "relation", domain: ["person", "organization"], range: ["event"], labels: { it: "partecipò a", en: "took part in" } },
  { id: "controlled_by", kind: "relation", domain: ["place", "territory"], range: ["organization", "person"], labels: { it: "controllato da", en: "controlled by" } },
  { id: "set_in", kind: "relation", domain: ["legend", "work"], range: ["place", "territory"], labels: { it: "ambientato a", en: "set in" } },
  { id: "dedicated_to", kind: "relation", domain: ["place", "work"], range: ["person", "event", "legend"], labels: { it: "dedicato a", en: "dedicated to" } },
  { id: "named_after", kind: "relation", domain: ["place", "territory"], range: ["person", "legend", "theme", "event"], labels: { it: "prende il nome da", en: "named after" } },
  { id: "during", kind: "relation", domain: ["event", "place", "work"], range: ["period"], labels: { it: "durante", en: "during" } },
  { id: "has_theme", kind: "relation", domain: ANY, range: ["theme"], labels: { it: "riguarda il tema", en: "relates to theme" } },
  // Valori strutturati
  { id: "dated", kind: "value", domain: ["place", "work", "event"], value: "year_range", labels: { it: "datato", en: "dated" } },
  { id: "lifespan", kind: "value", domain: ["person"], value: "year_range", labels: { it: "visse", en: "lived" } },
  { id: "measures", kind: "value", domain: ["place", "work"], value: "measure", labels: { it: "misura", en: "measures" } },
  // Affermazioni testuali
  { id: "described_as", kind: "statement", domain: ANY, labels: { it: "descrizione", en: "description" } },
  { id: "tells", kind: "statement", domain: ["legend"], labels: { it: "racconta", en: "tells" } },
] as const satisfies readonly PredicateDefinition[];

export type PredicateId = (typeof PREDICATES)[number]["id"];

const BY_ID = new Map<string, PredicateDefinition>(PREDICATES.map((p) => [p.id, p]));

export function getPredicate(id: string): PredicateDefinition | undefined {
  return BY_ID.get(id);
}

export function kindAllowed(allowed: readonly NodeKind[] | "any" | undefined, kind: NodeKind): boolean {
  return allowed === "any" || (allowed?.includes(kind) ?? false);
}
