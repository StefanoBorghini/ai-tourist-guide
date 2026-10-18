import type {
  AnchorKind,
  AssertionType,
  Audience,
  Certainty,
  CoordinateStatus,
  GeofenceKind,
  Locale,
  MediaLicense,
  NodeKind,
  PlaceKind,
  PracticalKind,
  PredicateId,
  ReleaseStage,
  RouteCalibration,
  RouteDifficulty,
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
  /** Presente solo se false: il luogo non si raggiunge a piedi (es. un'isola). */
  walkable?: false;
  geofences: BundleGeofence[];
  coordinateStatus: CoordinateStatus;
  /** Solo nei bundle di anteprima: stato del racconto e note per il test sul campo. */
  curation?: { storyStatus?: string; notes: string[] };
  practical: BundlePractical[];
}

/** Informazione pratica datata: l'app la mostra con la data di controllo, mai come fatto storico. */
export interface BundlePractical {
  kind: PracticalKind;
  text: string;
  checkedAt: string;
  recheckAfterDays: number;
  source?: string;
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
  url?: string;
  priority?: string;
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
  /** Solo nei bundle di anteprima: affermazione ancora in revisione, non verificata. */
  inReview?: true;
  /** Il collegamento alla fonte è solo dedotto, non ancora confermato sulla fonte. */
  sourceUnconfirmed?: true;
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
  calibration: RouteCalibration;
  difficulty?: RouteDifficulty;
  elevationGainM?: number;
  sources: string[];
}

export interface BundleMedia {
  ref: string;
  /** Assente = immagine. I video non fanno parte del pacchetto offline: si caricano solo quando servono. */
  kind?: "video";
  /** Percorso del file nel bundle (indirizzato per contenuto). */
  path: string;
  /** Per i video: immagine mostrata prima e al posto del video (nel pacchetto offline). */
  poster?: string;
  /** Copertina della destinazione. */
  cover?: true;
  subjects: string[];
  alt: string;
  caption?: string;
  license: MediaLicense;
  author?: string;
  /** Testo da mostrare accanto all'immagine, quando la licenza lo richiede. */
  attribution?: string;
  originalUrl?: string;
}

export interface BundleContent {
  bundleSchemaVersion: typeof BUNDLE_SCHEMA_VERSION;
  destination: string;
  name: string;
  locale: Locale;
  flavor: BundleFlavor;
  fictional: boolean;
  /**
   * Bundle di anteprima (territorio in ricerca o in prova sul campo): può contenere
   * affermazioni in revisione, marcate inReview. L'app lo dichiara sempre all'utente.
   */
  preview: boolean;
  releaseStage: ReleaseStage;
  editorialStatus?: string;
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
  media: BundleMedia[];
  /** Presente solo se la destinazione ha contenuti a pagamento: dice all'app che cosa manca e perché. */
  locked?: BundleLocked;
}

/** Contenuti a pagamento esclusi dal bundle pubblico. */
export interface BundleLocked {
  /** I racconti dell'esplorazione completa non ci sono (restano le aperture dei luoghi introduttivi). */
  explore: boolean;
  /** Percorsi premium: solo nome e durata, per presentarli. */
  routes: { ref: string; name: string; durationMin: number }[];
}

/**
 * Parte a pagamento di un bundle: mai nei file pubblici. "explore" contiene i racconti dell'esplorazione
 * completa; "route" un percorso premium con i racconti delle sue tappe che non sono già pubblici.
 */
export interface PremiumPart {
  kind: "explore" | "route";
  /** Percorso, per le parti "route". */
  ref?: string;
  units: BundleUnit[];
  assertions: BundleAssertion[];
  routes: BundleRoute[];
  sources: BundleSource[];
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
  /**
   * File a pagamento di questa pubblicazione nel bucket privato «premium» (migrazione 20261027000000): solo nomi,
   * tipo e impronte, mai i contenuti. L'app li scarica con un indirizzo firmato, solo se l'utente ha il diritto.
   */
  premium?: PremiumFile[];
}

export interface PremiumFile {
  kind: PremiumPart["kind"];
  /** Percorso, per i file «route». */
  ref?: string;
  /** Percorso nel bucket «premium»: `<destinazione>/<lingua>/<pubblicazione>/(explore|route-<percorso>).<impronta>.json`. */
  path: string;
  sha256: string;
  bytes: number;
}
