import type {
  AnchorKind,
  AssertionType,
  Audience,
  Certainty,
  GeofenceKind,
  Locale,
  NodeKind,
  PlaceKind,
  PredicateId,
  SourceKind,
  SourceReliability,
  UnitType,
} from "@guide/domain";

/**
 * Formato del bundle di runtime, versione 1.
 *
 * Un bundle è ciò che l'app scarica per una destinazione in una lingua:
 *
 *   <destinazione>/<lingua>-<variante>/
 *     manifest.json              versione, hash, elenco dei file con sha256 e dimensione
 *     content.<hash>.json        contenuti compilati (questo file)
 *     audio/<hash>.m4a           (in futuro) audio delle unità
 *
 * Tutti i riferimenti sono in forma completa "pack:slug". Le affermazioni
 * presenti sono SOLO quelle raccontabili (verificate, di livello ammesso):
 * l'app non può raccontare ciò che non c'è.
 */

export const BUNDLE_SCHEMA_VERSION = 1;
export const MIN_APP_VERSION = "0.1.0";

export type BundleFlavor = "lite" | "full";

export interface BundleGeofence {
  kind: GeofenceKind;
  center: [number, number];
  radiusM: number;
  minDwellS: number;
  maxAccuracyM: number;
  viewBearingDeg?: number;
  viewToleranceDeg?: number;
}

export interface BundlePlace {
  ref: string;
  name: string;
  short?: string;
  placeKind: PlaceKind;
  categories: string[];
  location: [number, number];
  elevationM?: number;
  importance: number;
  dwellMin: number;
  partOf?: string;
  stepFree?: boolean;
  stairs?: number;
  geofences: BundleGeofence[];
}

export interface BundleAnchor {
  ref: string;
  name: string;
  anchorKind: AnchorKind;
  location: [number, number];
  safetyMarginMin: number;
}

export interface BundleNode {
  ref: string;
  kind: Exclude<NodeKind, "place">;
  name: string;
  short?: string;
}

export interface BundleSource {
  ref: string;
  sourceKind: SourceKind;
  title: string;
  authors: string[];
  institution?: string;
  year?: number;
  reliability: SourceReliability;
}

export interface BundleAssertion {
  ref: string;
  subject: string;
  predicate: PredicateId | string;
  object?: string;
  value?: { yearFrom: number; yearTo?: number; circa: boolean } | { amount: number; unit: string };
  type: AssertionType;
  certainty?: Certainty;
  text: string;
  /** Lingua effettiva del testo (diversa da quella del bundle se manca la traduzione). */
  textLocale: Locale;
  sources: string[];
}

export interface BundleUnit {
  ref: string;
  anchor: string;
  unitType: UnitType;
  audience: Audience;
  durationS: number;
  text: string;
  assertions: string[];
  introduces: string[];
  requires: string[];
  hooks: { target: string; text: string }[];
  resumeHook?: string;
}

export interface BundleRoute {
  ref: string;
  name: string;
  durationMin: number;
  stops: { place: string; dwellMin?: number; optional: boolean }[];
  endAnchor?: string;
}

export interface BundleContent {
  bundleSchemaVersion: typeof BUNDLE_SCHEMA_VERSION;
  destination: string;
  name: string;
  locale: Locale;
  flavor: BundleFlavor;
  fictional: boolean;
  packVersions: Record<string, string>;
  guide: { defaultMode: "auto" | "ask" | "silent"; maxProposalsPer10Min: number };
  safetyNotes: { id: string; text: string }[];
  places: BundlePlace[];
  anchors: BundleAnchor[];
  nodes: BundleNode[];
  sources: BundleSource[];
  assertions: BundleAssertion[];
  units: BundleUnit[];
  routes: BundleRoute[];
}

export interface BundleFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface BundleManifest {
  bundleSchemaVersion: typeof BUNDLE_SCHEMA_VERSION;
  minAppVersion: string;
  destination: string;
  locale: Locale;
  flavor: BundleFlavor;
  packVersions: Record<string, string>;
  /** Hash delle affermazioni incluse: cambia solo quando cambiano i fatti raccontabili. */
  kbHash: string;
  content: string;
  files: BundleFile[];
  totalBytes: number;
}
