/**
 * Vocabolari controllati condivisi da engine, pack e database.
 * Aggiungere un valore qui è una modifica di schema: va fatta con cura e
 * riflessa nella migrazione del database.
 */

export const LOCALES = ["it", "en", "fr", "de", "es"] as const;
export type Locale = (typeof LOCALES)[number];

export const PACK_KINDS = ["core", "region", "area", "destination"] as const;
export type PackKind = (typeof PACK_KINDS)[number];

export const NODE_KINDS = [
  "place",
  "territory",
  "person",
  "organization",
  "event",
  "period",
  "theme",
  "work",
  "legend",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** Sottotipo dei nodi "place". */
export const PLACE_KINDS = ["site", "poi", "feature"] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

/** Che cosa afferma un'affermazione (distinto da quanto è certa). */
export const ASSERTION_TYPES = ["fact", "interpretation", "tradition", "legend", "disputed"] as const;
export type AssertionType = (typeof ASSERTION_TYPES)[number];

/** Quanto è solida un'affermazione di tipo fact o interpretation. */
export const CERTAINTY_LEVELS = ["established", "probable", "uncertain"] as const;
export type Certainty = (typeof CERTAINTY_LEVELS)[number];

export const ASSERTION_STATUSES = ["draft", "in_review", "verified", "rejected", "deprecated", "blocked"] as const;
export type AssertionStatus = (typeof ASSERTION_STATUSES)[number];

export const QUALITY_TIERS = ["bronze", "silver", "gold"] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];

/** A primaria/scientifica · B istituzionale · C divulgativa · D testimonianza o tradizione orale. */
export const SOURCE_RELIABILITY = ["A", "B", "C", "D"] as const;
export type SourceReliability = (typeof SOURCE_RELIABILITY)[number];

export const SOURCE_KINDS = [
  "book",
  "academic_paper",
  "archive_document",
  "inscription",
  "catalogue_record",
  "institution",
  "oral_testimony",
  "website",
  "other",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const GEOFENCE_KINDS = ["arrival", "viewpoint"] as const;
export type GeofenceKind = (typeof GEOFENCE_KINDS)[number];

export const ANCHOR_KINDS = ["pier", "bus_stop", "train_station", "parking", "cruise_terminal", "other"] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

export const UNIT_TYPES = ["opening", "context", "detail", "curiosity", "legend", "closing", "transition"] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export const AUDIENCES = ["general", "family", "kids", "expert"] as const;
export type Audience = (typeof AUDIENCES)[number];

/** Provenienza di un'immagine o di un altro media. */
export const MEDIA_SOURCES = ["own_photo", "institution", "archive", "web", "other"] as const;
export type MediaSource = (typeof MEDIA_SOURCES)[number];

/**
 * Licenze ammesse per i media. Da ogni licenza derivano due regole:
 * se l'uso commerciale è permesso e se l'attribuzione è obbligatoria.
 */
export const MEDIA_LICENSES = [
  "own", // foto di proprietà del progetto (es. scattate dalla redazione)
  "public-domain",
  "cc0",
  "cc-by-4.0",
  "cc-by-sa-4.0",
  "cc-by-nc-4.0",
  "cc-by-nc-sa-4.0",
  "licensed", // licenza concessa per iscritto dal titolare dei diritti
  "all-rights-reserved",
] as const;
export type MediaLicense = (typeof MEDIA_LICENSES)[number];

export const LICENSE_RULES: Record<MediaLicense, { commercialUse: boolean; attributionRequired: boolean }> = {
  own: { commercialUse: true, attributionRequired: false },
  "public-domain": { commercialUse: true, attributionRequired: false },
  cc0: { commercialUse: true, attributionRequired: false },
  "cc-by-4.0": { commercialUse: true, attributionRequired: true },
  "cc-by-sa-4.0": { commercialUse: true, attributionRequired: true },
  "cc-by-nc-4.0": { commercialUse: false, attributionRequired: true },
  "cc-by-nc-sa-4.0": { commercialUse: false, attributionRequired: true },
  licensed: { commercialUse: true, attributionRequired: true },
  "all-rights-reserved": { commercialUse: false, attributionRequired: true },
};
