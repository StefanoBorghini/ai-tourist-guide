/**
 * Controllo di pubblicazione di un territorio del database, con gli stessi strumenti dei pack del repository:
 * istantanea (pack_snapshot) → pack validato con gli schemi → validatore → prova di compilazione dei bundle.
 * Puro: le istantanee e l'elenco dei file presenti nel bucket arrivano da fuori (test in test/readiness.test.ts).
 */
import { BundleBuildError, buildBundle } from "@guide/bundle";
import type { Locale, TerritoryPack } from "@guide/domain";
import { SnapshotError, snapshotToPack, validatePacks } from "@guide/territory-pack";

export interface ReadinessIssue {
  level: "error" | "warning";
  code: string;
  pack: string;
  message: string;
}

export interface ReadinessBundle {
  locale: string;
  places: number;
  units: number;
  assertions: number;
  routes: number;
  preview: boolean;
  kbHash: string;
}

export interface ReadinessReport {
  ok: boolean;
  pack: string;
  checkedAt: string;
  errors: ReadinessIssue[];
  warnings: ReadinessIssue[];
  bundles: ReadinessBundle[];
}

/** Cartella fittizia: il validatore vuole che si chiami come il pack. */
const virtualDir = (id: string) => `/studio-db/${id}`;

/**
 * @param target  territorio da controllare
 * @param snapshots  istantanee del territorio e dei territori da cui dipende (null se non leggibili)
 * @param storedFiles  percorsi presenti nel bucket «media» (`<pack>/<file>`)
 */
export function assessReadiness(target: string, snapshots: Map<string, Record<string, unknown> | null>, storedFiles: Set<string>, today?: string): ReadinessReport {
  const errors: ReadinessIssue[] = [];
  const warnings: ReadinessIssue[] = [];
  const packs = new Map<string, TerritoryPack>();
  for (const [id, snap] of snapshots) {
    if (!snap) {
      errors.push({ level: "error", code: "DEPENDENCY_UNREADABLE", pack: id, message: `non puoi leggere il territorio ${id} da cui dipende: il controllo completo lo fa chi ha accesso a entrambi` });
      continue;
    }
    try {
      packs.set(id, snapshotToPack(snap, virtualDir(id)));
    } catch (e) {
      const issues = e instanceof SnapshotError ? e.issues : [{ file: "", item: "", message: String(e) }];
      for (const i of issues) errors.push({ level: "error", code: "SCHEMA", pack: id, message: `${i.file} ${i.item}: ${i.message}` });
    }
  }
  const pack = packs.get(target);
  const result = (bundles: ReadinessBundle[] = []): ReadinessReport => ({
    ok: errors.length === 0, pack: target, checkedAt: new Date().toISOString(), errors, warnings, bundles,
  });
  if (!pack) {
    if (!errors.some((e) => e.pack === target)) errors.push({ level: "error", code: "NOT_FOUND", pack: target, message: "territorio non trovato" });
    return result();
  }

  // Validatore dei pack. I file media stanno nel bucket, non su disco: il controllo dei file è fatto qui sotto.
  for (const i of validatePacks(packs, today ? { today } : {})) {
    if (i.code === "MEDIA_FILE_MISSING") continue;
    if (i.packId !== target && i.level === "warning") continue;
    const issue = { level: i.level, code: i.code, pack: i.packId, message: [i.item, i.message].filter(Boolean).join(": ") };
    (i.level === "error" ? errors : warnings).push(issue);
  }
  for (const m of pack.media) {
    for (const f of [m.file, ...(m.poster ? [m.poster] : [])]) {
      if (!storedFiles.has(`${target}/${f}`)) {
        errors.push({ level: "error", code: "MEDIA_NOT_IN_STORAGE", pack: target, message: `${m.id}: file ${f} non presente nel bucket media` });
      }
    }
  }

  if (pack.manifest.kind !== "destination") {
    warnings.push({ level: "warning", code: "CONTAINER", pack: target, message: "le regioni e le aree non arrivano all'app da sole: arrivano le destinazioni che dipendono da loro" });
    return result();
  }
  if (pack.places.length === 0) errors.push({ level: "error", code: "NO_PLACES", pack: target, message: "nessun luogo" });
  if (pack.manifest.fictional) errors.push({ level: "error", code: "FICTIONAL", pack: target, message: "territorio fittizio: non si pubblica" });

  // Prova di compilazione, una per lingua, senza file media (i file li aggiunge la pipeline).
  const bundles: ReadinessBundle[] = [];
  if (!errors.length) {
    const withoutMedia = new Map([...packs].map(([id, p]) => [id, { ...p, media: [] }]));
    for (const locale of pack.manifest.locales) {
      try {
        const b = buildBundle(withoutMedia, { destination: target, locale: locale as Locale });
        bundles.push({
          locale, places: b.content.places.length, units: b.content.units.length, assertions: b.content.assertions.length,
          routes: b.content.routes.length, preview: b.content.preview, kbHash: b.manifest.kbHash,
        });
        if (b.content.units.length === 0) {
          const level = locale === pack.manifest.defaultLocale ? "error" : "warning";
          (level === "error" ? errors : warnings).push({ level, code: "NO_NARRATION", pack: target, message: `nessun racconto raccontabile in ${locale}: servono racconti legati ad affermazioni verificate${b.content.preview ? " o in revisione" : ""}` });
        }
      } catch (e) {
        errors.push({ level: "error", code: "BUNDLE", pack: target, message: e instanceof BundleBuildError ? e.message : String(e) });
      }
    }
  }
  return result(bundles);
}
