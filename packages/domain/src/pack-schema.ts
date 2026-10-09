import { z } from "zod";
import { PACK_ID_PATTERN, REF_PATTERN, SLUG_PATTERN } from "./ids.ts";
import {
  ANCHOR_KINDS,
  ASSERTION_STATUSES,
  ASSERTION_TYPES,
  AUDIENCES,
  CERTAINTY_LEVELS,
  COORDINATE_STATUSES,
  EVIDENCE_ATTRIBUTIONS,
  GEOFENCE_KINDS,
  LOCALES,
  MEDIA_LICENSES,
  MEDIA_SOURCES,
  NODE_KINDS,
  PACK_KINDS,
  PLACE_KINDS,
  PRACTICAL_KINDS,
  QUALITY_TIERS,
  RELEASE_STAGES,
  ROUTE_CALIBRATIONS,
  ROUTE_DIFFICULTIES,
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
 *     media/media.yaml           immagini con provenienza e licenza (file in media/files/)
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
const isoDate = z.iso.date();
/** Stato redazionale libero, in maiuscolo (es. FACTS_ONLY_UNTIL_PRIMARY_SOURCE_VERIFIED). */
const editorialStatus = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "stato in MAIUSCOLO_CON_TRATTINI_BASSI");

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
  /** Stadio del pack: research e field_test producono solo bundle di anteprima. */
  releaseStage: z.enum(RELEASE_STAGES).default("production"),
  /** Stato dichiarato dalla redazione (es. RESEARCH_READY_NOT_PRODUCTION_VERIFIED). */
  editorialStatus: editorialStatus.optional(),
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
  media: z
    .strictObject({
      /** Ammette nel pacchetto pubblicato media con licenza non commerciale (es. progetto non profit). */
      allowNonCommercial: z.boolean().default(false),
    })
    .default({ allowNonCommercial: false }),
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

/** Fonte cartografica usata per controllare una coordinata (verifica su mappa, distinta dal rilievo sul campo). */
export const mapSourceSchema = z.strictObject({
  title: z.string().trim().min(1),
  url: z.url().optional(),
  reliability: z.enum(SOURCE_RELIABILITY),
  /** Coordinate riportate dalla fonte [lng, lat], se diverse da quelle adottate. */
  value: lngLat.optional(),
  note: z.string().trim().min(1).optional(),
});

/** Affidabilità delle coordinate: preliminari finché qualcuno non le controlla su mappa e poi le rileva sul posto. */
export const coordinatesSchema = z
  .strictObject({
    status: z.enum(COORDINATE_STATUSES).default("preliminary"),
    verifiedAt: isoDate.optional(),
    verifiedBy: z.string().trim().min(1).optional(),
    /** Come sono state ottenute (es. "rilievo GPS sul posto, precisione 4 m"). */
    method: z.string().trim().min(1).optional(),
    /** Verifica cartografica: data, fonti (la prima è quella adottata), coordinate precedenti. */
    mapVerifiedAt: isoDate.optional(),
    mapSources: z.array(mapSourceSchema).default([]),
    previousLocation: lngLat.optional(),
  })
  .refine((c) => c.status !== "field_verified" || (c.verifiedAt !== undefined && c.verifiedBy !== undefined), {
    message: "coordinate field_verified richiedono verifiedAt e verifiedBy",
  })
  .refine((c) => c.status !== "map_verified" || (c.mapVerifiedAt !== undefined && c.mapSources.length > 0), {
    message: "coordinate map_verified richiedono mapVerifiedAt e almeno una fonte in mapSources",
  });

/** Curatela del luogo: stato del racconto, note di campo, ultima verifica. */
export const curationSchema = z.strictObject({
  storyStatus: editorialStatus.optional(),
  notes: z.array(z.string().trim().min(1)).default([]),
  lastVerifiedAt: isoDate.optional(),
  verifiedBy: z.string().trim().min(1).optional(),
});

/**
 * Informazione pratica (orari, accessi, trasporti, permessi): non è un fatto storico,
 * ha una data di controllo e va ricontrollata dopo recheckAfterDays.
 */
export const practicalInfoSchema = z.strictObject({
  id: slug,
  kind: z.enum(PRACTICAL_KINDS),
  text: localized,
  source: ref.optional(),
  checkedAt: isoDate,
  recheckAfterDays: z.number().int().min(1).max(730).default(90),
});
export type PracticalInfo = z.infer<typeof practicalInfoSchema>;

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
      notes: localized.optional(),
    })
    .optional(),
  coordinates: coordinatesSchema.default({ status: "preliminary", mapSources: [] }),
  curation: curationSchema.optional(),
  practical: z.array(practicalInfoSchema).default([]),
  /** Raggiungibile a piedi dal resto della destinazione? Se no (es. un'isola), la guida non lo propone come tappa a piedi. */
  walkable: z.boolean().default(true),
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
  /** Priorità dichiarata dalla ricerca (es. PRIMARY, SECONDARY_LOCAL), conservata com'è. */
  priority: editorialStatus.optional(),
  /** Id originale nel materiale importato, per la tracciabilità. */
  originalId: z.string().trim().min(1).optional(),
  accessedAt: isoDate.optional(),
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
  /** "inferred" se il collegamento alla fonte è dedotto e non ancora controllato sulla fonte stessa. */
  attribution: z.enum(EVIDENCE_ATTRIBUTIONS).default("explicit"),
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
  /** Testo originale della ricerca da cui deriva, conservato per il controllo redazionale. */
  originalClaim: z.string().trim().min(1).optional(),
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
  calibration: z.enum(ROUTE_CALIBRATIONS).default("draft"),
  difficulty: z.enum(ROUTE_DIFFICULTIES).optional(),
  elevationGainM: z.number().int().min(0).max(5000).optional(),
  /** Fonti di durata, difficoltà e dislivello. */
  sources: z.array(ref).default([]),
  notes: z.array(z.string().trim().min(1)).default([]),
  stops: z
    .array(
      z.strictObject({
        place: ref,
        dwellMin: z.number().int().min(1).max(240).optional(),
        optional: z.boolean().default(false),
      }),
    )
    .min(1),
  endAnchor: slug.optional(),
});
export type Route = z.infer<typeof routeSchema>;

// ------------------------------------------------------------------ media/media.yaml

export const mediaSchema = z
  .strictObject({
    id: slug,
    kind: z.enum(["image"]),
    /** File nella cartella del pack, relativo a media/files/. */
    file: z.string().regex(/^[\w.-]+\.(jpe?g|png|webp)$/i, "nome file non valido (jpg, png, webp)"),
    /** Luoghi o nodi raffigurati. */
    subjects: z.array(ref).min(1),
    caption: localized.optional(),
    /** Testo alternativo per l'accessibilità. */
    alt: localized,
    source: z.enum(MEDIA_SOURCES),
    author: z.string().trim().min(1).optional(),
    license: z.enum(MEDIA_LICENSES),
    attribution: z.string().trim().min(1).optional(),
    originalUrl: z.url().optional(),
    /** Per le licenze concesse per iscritto: riferimento all'accordo. */
    licenseNote: z.string().trim().min(1).optional(),
    takenAt: z.iso.date().optional(),
    /** Posizione di scatto (es. dai dati EXIF della foto). */
    location: lngLat.optional(),
  })
  .refine((m) => m.license === "public-domain" || m.author !== undefined, {
    message: "autore obbligatorio (salvo pubblico dominio)",
    path: ["author"],
  })
  .refine((m) => m.license !== "licensed" || m.licenseNote !== undefined, {
    message: "una licenza concessa per iscritto richiede licenseNote",
    path: ["licenseNote"],
  });
export type Media = z.infer<typeof mediaSchema>;

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
  media: { path: "media/media.yaml", schema: z.array(mediaSchema) },
} as const;

/** Cartella dei file media dentro un pack. */
export const MEDIA_FILES_DIR = "media/files";

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
  media: Media[];
}
