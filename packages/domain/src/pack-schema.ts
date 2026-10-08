import { z } from "zod";
import { PACK_ID_PATTERN, REF_PATTERN, SLUG_PATTERN } from "./ids.ts";
import {
  ANCHOR_KINDS,
  ASSERTION_STATUSES,
  ASSERTION_TYPES,
  AUDIENCES,
  CERTAINTY_LEVELS,
  GEOFENCE_KINDS,
  LOCALES,
  NODE_KINDS,
  PACK_KINDS,
  PLACE_KINDS,
  QUALITY_TIERS,
  SOURCE_KINDS,
  SOURCE_RELIABILITY,
  UNIT_TYPES,
} from "./vocabulary.ts";

/**
 * Schema del Territory Pack, versione 1.
 *
 * Un pack è una cartella:
 *
 *   <pack-id>/
 *     pack.yaml                  identità, dipendenze, lingue
 *     config.yaml                configurazione del territorio
 *     geography/places.yaml      luoghi con coordinate e geofence
 *     geography/anchors.yaml     ancore (imbarcaderi, fermate, parcheggi)
 *     knowledge/nodes.yaml       nodi non spaziali (persone, eventi, temi, leggende…)
 *     knowledge/sources.yaml     fonti
 *     knowledge/assertions.yaml  affermazioni con prove
 *     narrative/units.yaml       unità narrative
 *     narrative/routes.yaml      percorsi curati
 *
 * Tutti i file tranne pack.yaml sono facoltativi.
 */

export const PACK_SCHEMA_VERSION = 1;

const slug = z.string().regex(SLUG_PATTERN, "slug non valido (minuscole, cifre, trattini)");
const ref = z.string().regex(REF_PATTERN, "riferimento non valido: usare 'slug' o 'pack.id:slug'");
const locale = z.enum(LOCALES);
const localized = z.partialRecord(locale, z.string().trim().min(1));
const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const year = z.number().int().min(-5000).max(2100);

export const labelsSchema = z.partialRecord(
  locale,
  z.strictObject({
    name: z.string().trim().min(1),
    short: z.string().trim().min(1).optional(),
    aliases: z.array(z.string().trim().min(1)).optional(),
  }),
);

// ---------------------------------------------------------------- pack.yaml

export const packManifestSchema = z.strictObject({
  schemaVersion: z.literal(PACK_SCHEMA_VERSION),
  id: z.string().regex(PACK_ID_PATTERN, "id del pack non valido"),
  kind: z.enum(PACK_KINDS),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "versione semver attesa (es. 1.0.0)"),
  name: localized,
  defaultLocale: locale,
  locales: z.array(locale).min(1),
  qualityTier: z.enum(QUALITY_TIERS),
  dependsOn: z.array(z.string().regex(PACK_ID_PATTERN)).default([]),
  fictional: z.boolean().default(false),
});
export type PackManifest = z.infer<typeof packManifestSchema>;

// -------------------------------------------------------------- config.yaml

export const territoryConfigSchema = z.strictObject({
  narration: z
    .strictObject({
      /** Livelli di qualità che la guida può usare per raccontare. */
      allowedQualityTiers: z.array(z.enum(QUALITY_TIERS)).min(1).default(["silver", "gold"]),
    })
    .default({ allowedQualityTiers: ["silver", "gold"] }),
  guide: z
    .strictObject({
      defaultMode: z.enum(["auto", "ask", "silent"]).default("ask"),
      maxProposalsPer10Min: z.number().int().min(0).max(10).default(2),
    })
    .default({ defaultMode: "ask", maxProposalsPer10Min: 2 }),
  features: z
    .strictObject({
      partnerSuggestions: z.boolean().default(false),
    })
    .default({ partnerSuggestions: false }),
  safetyNotes: z.array(z.strictObject({ id: slug, text: localized })).default([]),
});
export type TerritoryConfig = z.infer<typeof territoryConfigSchema>;

// --------------------------------------------------- geography/places.yaml

export const geofenceSchema = z
  .strictObject({
    kind: z.enum(GEOFENCE_KINDS),
    radiusM: z.number().min(5).max(2000),
    /** Centro, se diverso dalla posizione del luogo (es. punto panoramico). */
    center: lngLat.optional(),
    minDwellS: z.number().int().min(0).max(120).default(8),
    maxAccuracyM: z.number().int().min(5).max(200).default(35),
    /** Solo per 'viewpoint': direzione in cui si vede il luogo. */
    viewBearingDeg: z.number().min(0).max(359).optional(),
    viewToleranceDeg: z.number().min(5).max(180).optional(),
  })
  .refine((g) => g.kind === "viewpoint" || g.viewBearingDeg === undefined, {
    message: "viewBearingDeg ammesso solo per i geofence 'viewpoint'",
  })
  .refine((g) => g.kind !== "viewpoint" || g.center !== undefined, {
    message: "un geofence 'viewpoint' deve indicare il proprio center",
  });

export const placeSchema = z.strictObject({
  id: slug,
  placeKind: z.enum(PLACE_KINDS),
  categories: z.array(slug).min(1),
  location: lngLat,
  elevationM: z.number().optional(),
  importance: z.number().int().min(1).max(5),
  dwellMin: z.number().int().min(1).max(240),
  partOf: ref.optional(),
  labels: labelsSchema,
  geofences: z.array(geofenceSchema).default([]),
  accessibility: z
    .strictObject({
      stepFree: z.boolean().optional(),
      stairs: z.number().int().min(0).optional(),
    })
    .optional(),
});
export type Place = z.infer<typeof placeSchema>;

export const anchorSchema = z.strictObject({
  id: slug,
  anchorKind: z.enum(ANCHOR_KINDS),
  location: lngLat,
  /** Margine di sicurezza minimo, in minuti, da tenere prima di una scadenza. */
  safetyMarginMin: z.number().int().min(0).max(120),
  labels: labelsSchema,
});
export type Anchor = z.infer<typeof anchorSchema>;

// -------------------------------------------------- knowledge/nodes.yaml

export const nodeSchema = z.strictObject({
  id: slug,
  kind: z.enum(NODE_KINDS).exclude(["place"]),
  labels: labelsSchema,
  attributes: z.record(z.string(), z.unknown()).default({}),
});
export type KnowledgeNode = z.infer<typeof nodeSchema>;

// ------------------------------------------------ knowledge/sources.yaml

export const sourceSchema = z.strictObject({
  id: slug,
  sourceKind: z.enum(SOURCE_KINDS),
  title: z.string().trim().min(1),
  authors: z.array(z.string().trim().min(1)).default([]),
  institution: z.string().trim().min(1).optional(),
  year: year.optional(),
  language: locale.optional(),
  reliability: z.enum(SOURCE_RELIABILITY),
  url: z.url().optional(),
  license: z.string().optional(),
  fictional: z.boolean().default(false),
});
export type Source = z.infer<typeof sourceSchema>;

// --------------------------------------------- knowledge/assertions.yaml

export const assertionValueSchema = z.union([
  z
    .strictObject({ yearFrom: year, yearTo: year.optional(), circa: z.boolean().default(false) })
    .refine((v) => v.yearTo === undefined || v.yearTo >= v.yearFrom, { message: "yearTo precede yearFrom" }),
  z.strictObject({ amount: z.number(), unit: z.string().trim().min(1) }),
]);

export const evidenceSchema = z.strictObject({
  source: ref,
  locator: z.string().trim().min(1).optional(),
  excerpt: z.string().trim().min(1).optional(),
});

export const assertionSchema = z.strictObject({
  id: slug,
  subject: ref,
  predicate: z.string(),
  object: ref.optional(),
  value: assertionValueSchema.optional(),
  type: z.enum(ASSERTION_TYPES),
  certainty: z.enum(CERTAINTY_LEVELS).optional(),
  status: z.enum(ASSERTION_STATUSES),
  qualityTier: z.enum(QUALITY_TIERS).optional(),
  /** Gruppo di affermazioni in conflitto tra loro (stesso valore = stessa controversia). */
  dispute: slug.optional(),
  texts: localized,
  evidence: z.array(evidenceSchema).default([]),
  authoredBy: z.string().trim().min(1),
  verifiedBy: z.string().trim().min(1).optional(),
});
export type Assertion = z.infer<typeof assertionSchema>;

// ---------------------------------------------------- narrative/units.yaml

export const unitSchema = z.strictObject({
  id: slug,
  /** Nodo a cui l'unità è legata (di solito un luogo). */
  anchor: ref,
  unitType: z.enum(UNIT_TYPES),
  locale,
  audience: z.enum(AUDIENCES).default("general"),
  durationS: z.number().int().min(5).max(120),
  text: z.string().trim().min(1),
  assertions: z.array(slug).min(1),
  introduces: z.array(ref).default([]),
  requires: z.array(ref).default([]),
  hooks: z.array(z.strictObject({ target: ref, text: z.string().trim().min(1) })).default([]),
  /** Frase-ponte per riprendere dopo un'interruzione. */
  resumeHook: z.string().trim().min(1).optional(),
});
export type NarrativeUnit = z.infer<typeof unitSchema>;

// --------------------------------------------------- narrative/routes.yaml

export const routeSchema = z.strictObject({
  id: slug,
  labels: labelsSchema,
  durationMin: z.number().int().min(5).max(600),
  stops: z
    .array(
      z.strictObject({
        place: ref,
        dwellMin: z.number().int().min(1).max(240).optional(),
        optional: z.boolean().default(false),
      }),
    )
    .min(2),
  endAnchor: slug.optional(),
});
export type Route = z.infer<typeof routeSchema>;

// ------------------------------------------------------------------ files

export const PACK_FILES = {
  manifest: { path: "pack.yaml", schema: packManifestSchema },
  config: { path: "config.yaml", schema: territoryConfigSchema },
  places: { path: "geography/places.yaml", schema: z.array(placeSchema) },
  anchors: { path: "geography/anchors.yaml", schema: z.array(anchorSchema) },
  nodes: { path: "knowledge/nodes.yaml", schema: z.array(nodeSchema) },
  sources: { path: "knowledge/sources.yaml", schema: z.array(sourceSchema) },
  assertions: { path: "knowledge/assertions.yaml", schema: z.array(assertionSchema) },
  units: { path: "narrative/units.yaml", schema: z.array(unitSchema) },
  routes: { path: "narrative/routes.yaml", schema: z.array(routeSchema) },
} as const;

export interface TerritoryPack {
  /** Cartella da cui è stato caricato (solo informativo). */
  dir: string;
  manifest: PackManifest;
  config: TerritoryConfig;
  places: Place[];
  anchors: Anchor[];
  nodes: KnowledgeNode[];
  sources: Source[];
  assertions: Assertion[];
  units: NarrativeUnit[];
  routes: Route[];
}
