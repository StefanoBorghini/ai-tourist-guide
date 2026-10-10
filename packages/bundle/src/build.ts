import { createHash } from "node:crypto";
import {
  formatNodeRef,
  LICENSE_RULES,
  resolveRef,
  type Assertion,
  type Locale,
  MEDIA_FILES_DIR,
  type TerritoryPack,
} from "@guide/domain";
import { reachablePacks } from "@guide/narrative-planner";
import { hasErrors, validatePacks, type PackIssue } from "@guide/territory-pack";
import {
  BUNDLE_SCHEMA_VERSION,
  MIN_APP_VERSION,
  type BundleAssertion,
  type BundleContent,
  type BundleFlavor,
  type BundleManifest,
  type BundleMedia,
  type BundleNode,
  type BundlePlace,
  type BundleSource,
  type BundleUnit,
} from "./format.ts";

export class BundleBuildError extends Error {
  constructor(
    message: string,
    readonly issues: PackIssue[] = [],
  ) {
    super(message);
    this.name = "BundleBuildError";
  }
}

export interface BuildOptions {
  destination: string;
  locale: Locale;
  flavor?: BundleFlavor;
  /** Solo per i test: permette di compilare territori fittizi. */
  allowFictional?: boolean;
  /**
   * Legge un file media del pack (cartella del pack, percorso relativo).
   * Senza questa funzione i media non vengono inclusi (la compilazione resta pura).
   */
  readAsset?: (packDir: string, relativePath: string) => Uint8Array;
}

export interface BuiltBundle {
  manifest: BundleManifest;
  content: BundleContent;
  /** File da scrivere, per percorso relativo alla cartella del bundle. */
  files: Map<string, string | Uint8Array>;
  /**
   * File da pubblicare accanto al bundle ma fuori dal manifest (video): non entrano nel pacchetto
   * offline né nella verifica d'integrità, si scaricano solo quando l'app li mostra.
   */
  streamFiles: Map<string, Uint8Array>;
}

const sha256 = (data: string | Uint8Array) =>
  typeof data === "string" ? createHash("sha256").update(data, "utf8").digest("hex") : createHash("sha256").update(data).digest("hex");
const byteLength = (data: string | Uint8Array) => (typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength);
const byRef = <T extends { ref: string }>(a: T, b: T) => a.ref.localeCompare(b.ref);

/**
 * Un'affermazione è raccontabile se verificata e di un livello ammesso dal territorio di destinazione.
 * In un bundle di anteprima lo è anche se in revisione (mai se bozza, respinta o bloccata).
 */
export function isNarratable(a: Assertion, pack: TerritoryPack, allowedTiers: readonly string[], preview = false): boolean {
  const statusOk = a.status === "verified" || (preview && a.status === "in_review");
  return statusOk && allowedTiers.includes(a.qualityTier ?? pack.manifest.qualityTier);
}

/**
 * Compila il bundle di una destinazione in una lingua.
 * Deterministico: stessi pack in ingresso → stessi byte → stesso hash.
 */
export function buildBundle(packs: ReadonlyMap<string, TerritoryPack>, options: BuildOptions): BuiltBundle {
  const { destination, locale } = options;
  const flavor = options.flavor ?? "full";
  const dest = packs.get(destination);
  if (!dest) throw new BundleBuildError(`destinazione non trovata: ${destination}`);
  if (dest.manifest.kind !== "destination") {
    throw new BundleBuildError(`${destination} è un pack di tipo ${dest.manifest.kind}, non una destinazione`);
  }
  if (dest.manifest.fictional && !options.allowFictional) {
    throw new BundleBuildError(`${destination} è un territorio fittizio: non si pubblica`);
  }
  if (!dest.manifest.locales.includes(locale)) {
    throw new BundleBuildError(`la lingua ${locale} non è tra quelle della destinazione (${dest.manifest.locales.join(", ")})`);
  }

  const scope = reachablePacks(destination, packs);
  const scopeIds = new Set(scope.map((p) => p.manifest.id));
  const issues = validatePacks(new Map([...packs].filter(([id]) => scopeIds.has(id))));
  if (hasErrors(issues)) {
    throw new BundleBuildError(
      "il territorio ha errori di validazione: correggerli prima di compilare",
      issues.filter((i) => i.level === "error"),
    );
  }

  const allowedTiers = dest.config.narration.allowedQualityTiers;
  // Territorio non ancora in produzione → bundle di anteprima, dichiarato come tale.
  const preview = dest.manifest.releaseStage !== "production";
  const pick = <T>(texts: Partial<Record<Locale, T>>, fallback: Locale): { value: T; locale: Locale } | null => {
    if (texts[locale] !== undefined) return { value: texts[locale] as T, locale };
    if (texts[fallback] !== undefined) return { value: texts[fallback] as T, locale: fallback };
    return null;
  };

  const places: BundlePlace[] = [];
  const nodes: BundleNode[] = [];
  const anchors: BundleContent["anchors"] = [];
  const assertions: BundleAssertion[] = [];
  const units: BundleUnit[] = [];
  const routes: BundleContent["routes"] = [];
  const allSources = new Map<string, BundleSource>();
  const media: BundleMedia[] = [];
  const assetFiles = new Map<string, Uint8Array>();
  const streamFiles = new Map<string, Uint8Array>();
  const allowNonCommercial = dest.config.media.allowNonCommercial;

  for (const pack of scope) {
    const packId = pack.manifest.id;
    const fallback = pack.manifest.defaultLocale;
    const full = (raw: string) => formatNodeRef(resolveRef(raw, packId)!);
    const label = (labels: TerritoryPack["places"][number]["labels"]) => pick(labels, fallback)?.value;

    for (const p of pack.places) {
      const l = label(p.labels)!;
      places.push({
        ref: formatNodeRef({ packId, slug: p.id }),
        name: l.name,
        ...(l.short ? { short: l.short } : {}),
        placeKind: p.placeKind,
        categories: [...p.categories],
        location: [p.location[0], p.location[1]],
        ...(p.elevationM !== undefined ? { elevationM: p.elevationM } : {}),
        importance: p.importance,
        dwellMin: p.dwellMin,
        ...(p.partOf ? { partOf: full(p.partOf) } : {}),
        ...(p.accessibility?.stepFree !== undefined ? { stepFree: p.accessibility.stepFree } : {}),
        ...(p.accessibility?.stairs !== undefined ? { stairs: p.accessibility.stairs } : {}),
        ...(p.walkable === false ? { walkable: false as const } : {}),
        coordinateStatus: p.coordinates.status,
        ...(preview && p.curation
          ? { curation: { ...(p.curation.storyStatus ? { storyStatus: p.curation.storyStatus } : {}), notes: [...p.curation.notes] } }
          : {}),
        practical: p.practical.flatMap((info) => {
          const text = pick(info.text, fallback);
          if (!text) return [];
          return [{
            kind: info.kind,
            text: text.value,
            checkedAt: info.checkedAt,
            recheckAfterDays: info.recheckAfterDays,
            ...(info.source ? { source: full(info.source) } : {}),
          }];
        }),
        geofences: p.geofences.map((g) => ({
          kind: g.kind,
          center: [...(g.center ?? p.location)] as [number, number],
          radiusM: g.radiusM,
          minDwellS: g.minDwellS,
          maxAccuracyM: g.maxAccuracyM,
          ...(g.viewBearingDeg !== undefined ? { viewBearingDeg: g.viewBearingDeg } : {}),
          ...(g.viewToleranceDeg !== undefined ? { viewToleranceDeg: g.viewToleranceDeg } : {}),
        })),
      });
    }

    for (const n of pack.nodes) {
      const l = label(n.labels)!;
      nodes.push({ ref: formatNodeRef({ packId, slug: n.id }), kind: n.kind, name: l.name, ...(l.short ? { short: l.short } : {}) });
    }

    for (const a of pack.anchors) {
      anchors.push({
        ref: formatNodeRef({ packId, slug: a.id }),
        name: label(a.labels)!.name,
        anchorKind: a.anchorKind,
        location: [a.location[0], a.location[1]],
        safetyMarginMin: a.safetyMarginMin,
      });
    }

    for (const s of pack.sources) {
      allSources.set(formatNodeRef({ packId, slug: s.id }), {
        ref: formatNodeRef({ packId, slug: s.id }),
        sourceKind: s.sourceKind,
        title: s.title,
        authors: [...s.authors],
        ...(s.institution ? { institution: s.institution } : {}),
        ...(s.year !== undefined ? { year: s.year } : {}),
        reliability: s.reliability,
        ...(s.url ? { url: s.url } : {}),
        ...(s.priority ? { priority: s.priority } : {}),
      });
    }

    for (const a of pack.assertions) {
      if (!isNarratable(a, pack, allowedTiers, preview)) continue;
      const text = pick(a.texts, fallback);
      if (!text) continue;
      assertions.push({
        ref: formatNodeRef({ packId, slug: a.id }),
        subject: full(a.subject),
        predicate: a.predicate,
        ...(a.object ? { object: full(a.object) } : {}),
        ...(a.value ? { value: a.value } : {}),
        type: a.type,
        ...(a.certainty ? { certainty: a.certainty } : {}),
        text: text.value,
        textLocale: text.locale,
        sources: a.evidence.map((e) => full(e.source)).sort(),
        ...(a.status !== "verified" ? { inReview: true as const } : {}),
        ...(a.evidence.length > 0 && a.evidence.every((e) => e.attribution === "inferred") ? { sourceUnconfirmed: true as const } : {}),
      });
    }

    for (const u of pack.units) {
      if (u.locale !== locale) continue;
      if (flavor === "lite" && u.unitType !== "opening" && u.introduces.length === 0) continue;
      units.push({
        ref: formatNodeRef({ packId, slug: u.id }),
        anchor: full(u.anchor),
        unitType: u.unitType,
        audience: u.audience,
        durationS: u.durationS,
        text: u.text,
        assertions: u.assertions.map((a) => formatNodeRef({ packId, slug: a })),
        introduces: u.introduces.map(full),
        requires: u.requires.map(full),
        hooks: u.hooks.map((h) => ({ target: full(h.target), text: h.text })),
        ...(u.resumeHook ? { resumeHook: u.resumeHook } : {}),
      });
    }

    // Media: solo con licenza utilizzabile; mai "tutti i diritti riservati".
    for (const m of options.readAsset ? pack.media : []) {
      const rules = LICENSE_RULES[m.license];
      if (m.license === "all-rights-reserved" || (!rules.commercialUse && !allowNonCommercial)) continue;
      const alt = pick(m.alt, fallback);
      if (!alt) continue;
      const store = (file: string, into: Map<string, Uint8Array>) => {
        const data = options.readAsset!(pack.dir, `${MEDIA_FILES_DIR}/${file}`);
        const path = `media/${sha256(data).slice(0, 16)}.${file.split(".").pop()!.toLowerCase()}`;
        into.set(path, data);
        return path;
      };
      const video = m.kind === "video";
      const path = store(m.file, video ? streamFiles : assetFiles);
      const poster = video && m.poster ? store(m.poster, assetFiles) : undefined;
      const caption = m.caption ? pick(m.caption, fallback)?.value : undefined;
      media.push({
        ref: formatNodeRef({ packId, slug: m.id }),
        ...(video ? { kind: "video" as const } : {}),
        path,
        ...(poster ? { poster } : {}),
        ...(m.cover ? { cover: true as const } : {}),
        subjects: m.subjects.map(full).sort(),
        alt: alt.value,
        ...(caption ? { caption } : {}),
        license: m.license,
        ...(m.author ? { author: m.author } : {}),
        ...(m.attribution ? { attribution: m.attribution } : {}),
        ...(m.originalUrl ? { originalUrl: m.originalUrl } : {}),
      });
    }

    for (const r of pack.routes) {
      routes.push({
        ref: formatNodeRef({ packId, slug: r.id }),
        name: label(r.labels)!.name,
        durationMin: r.durationMin,
        stops: r.stops.map((s) => ({ place: full(s.place), ...(s.dwellMin !== undefined ? { dwellMin: s.dwellMin } : {}), optional: s.optional })),
        ...(r.endAnchor ? { endAnchor: formatNodeRef({ packId, slug: r.endAnchor }) } : {}),
        calibration: r.calibration,
        ...(r.difficulty ? { difficulty: r.difficulty } : {}),
        ...(r.elevationGainM !== undefined ? { elevationGainM: r.elevationGainM } : {}),
        sources: r.sources.map(full).sort(),
      });
    }
  }

  // Le unità che citano affermazioni non incluse vengono escluse (difesa in profondità:
  // il validatore lo impedisce già, ma il bundle non deve mai contenere fatti non raccontabili).
  const included = new Set(assertions.map((a) => a.ref));
  const safeUnits = units.filter((u) => u.assertions.every((a) => included.has(a)));
  // Fonti: solo quelle citate da affermazioni, percorsi e informazioni pratiche inclusi.
  const cited = new Set([
    ...assertions.flatMap((a) => a.sources),
    ...routes.flatMap((r) => r.sources),
    ...places.flatMap((p) => p.practical.flatMap((i) => (i.source ? [i.source] : []))),
  ]);
  const sources = [...allSources.values()].filter((s) => cited.has(s.ref));

  const content: BundleContent = {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    destination,
    name: pick(dest.manifest.name, dest.manifest.defaultLocale)!.value,
    locale,
    flavor,
    fictional: dest.manifest.fictional,
    preview,
    releaseStage: dest.manifest.releaseStage,
    ...(dest.manifest.editorialStatus ? { editorialStatus: dest.manifest.editorialStatus } : {}),
    packVersions: Object.fromEntries(scope.map((p) => [p.manifest.id, p.manifest.version]).sort(([a], [b]) => a!.localeCompare(b!))),
    guide: { defaultMode: dest.config.guide.defaultMode, maxProposalsPer10Min: dest.config.guide.maxProposalsPer10Min },
    safetyNotes: dest.config.safetyNotes
      .map((n) => ({ id: n.id, text: pick(n.text, dest.manifest.defaultLocale)?.value ?? "" }))
      .filter((n) => n.text),
    places: places.sort(byRef),
    anchors: anchors.sort(byRef),
    nodes: nodes.sort(byRef),
    sources: sources.sort(byRef),
    assertions: assertions.sort(byRef),
    units: safeUnits.sort(byRef),
    routes: routes.sort(byRef),
    media: media.sort(byRef),
  };

  const contentJson = JSON.stringify(content);
  const contentHash = sha256(contentJson);
  const contentPath = `content.${contentHash.slice(0, 16)}.json`;
  const kbHash = sha256(JSON.stringify(content.assertions.map((a) => [a.ref, a.text, a.type, a.certainty ?? null, a.value ?? null])));

  const files = new Map<string, string | Uint8Array>([[contentPath, contentJson], ...[...assetFiles].sort(([a], [b]) => a.localeCompare(b))]);
  const fileEntries = [...files].map(([path, data]) => ({ path, sha256: sha256(data), bytes: byteLength(data) }));
  const manifest: BundleManifest = {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    minAppVersion: MIN_APP_VERSION,
    destination,
    locale,
    flavor,
    packVersions: content.packVersions,
    kbHash,
    content: contentPath,
    files: fileEntries,
    totalBytes: fileEntries.reduce((s, f) => s + f.bytes, 0),
  };
  files.set("manifest.json", JSON.stringify(manifest, null, 2));
  return { manifest, content, files, streamFiles };
}
