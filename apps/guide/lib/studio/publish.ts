/**
 * Compilazione di una pubblicazione: dal territorio nel database ai file dei bundle da mettere nel bucket
 * pubblico «bundles». Puro: istantanee e file media arrivano da fuori (test in test/publish.test.ts);
 * il caricamento e la registrazione li fa lib/studio/server.ts.
 *
 * Stessi strumenti del build dai file: pack validato dagli schemi → buildBundle con i file media.
 * I file media si verificano con l'impronta registrata nel database: un file diverso da quello
 * descritto (autore, licenza, luoghi) non si pubblica.
 */
import { createHash } from "node:crypto";
import { buildBundle, BundleBuildError, type BundleManifest } from "@guide/bundle";
import { MEDIA_FILES_DIR, type Locale, type TerritoryPack } from "@guide/domain";
import { SnapshotError, snapshotToPack } from "@guide/territory-pack";
import { bundleFolder, indexEntry, pubBase, type BundleIndexEntry } from "../bundle-index";

type Snapshot = Record<string, unknown>;
interface SnapshotMedia {
  id: string;
  file: string;
  poster?: string;
  sha256?: string;
  kind?: string;
}

export interface PublicationBundle {
  locale: string;
  /** Cartella nel bucket «bundles» (`<destinazione>/<lingua>-full`). */
  folder: string;
  manifest: BundleManifest;
  entry: BundleIndexEntry;
  places: number;
  units: number;
  /** File con l'impronta nel nome (contenuto e media): non cambiano mai, si caricano una volta. */
  immutable: Map<string, Uint8Array>;
  /** Video: fuori dal pacchetto offline ma pubblicati accanto. */
  stream: Map<string, Uint8Array>;
  /** manifest.json: cambia a ogni pubblicazione, si carica per ultimo. */
  manifestJson: string;
}

export interface CompiledPublication {
  ok: boolean;
  errors: string[];
  warnings: string[];
  bundles: PublicationBundle[];
}

/** Sopra questa dimensione una foto rallenta lo scaricamento per l'uso senza rete. */
export const LARGE_IMAGE_BYTES = 2.5 * 1024 * 1024;

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const packIdOf = (dir: string) => dir.slice(dir.lastIndexOf("/") + 1);
const virtualDir = (id: string) => `/studio-db/${id}`;

/** Percorsi nel bucket «media» dei file che servono a compilare questi territori. */
export function mediaPaths(snapshots: Map<string, Snapshot | null>): string[] {
  const paths: string[] = [];
  for (const [id, snap] of snapshots) {
    for (const m of ((snap?.media ?? []) as SnapshotMedia[])) {
      paths.push(`${id}/${m.file}`);
      if (m.poster) paths.push(`${id}/${m.poster}`);
    }
  }
  return [...new Set(paths)];
}

/**
 * @param target  destinazione da pubblicare
 * @param snapshots  istantanee della destinazione e dei territori da cui dipende
 * @param files  contenuto dei file media presenti nel bucket, per percorso `<pack>/<file>`
 */
export function compilePublication(target: string, snapshots: Map<string, Snapshot | null>, files: Map<string, Uint8Array>): CompiledPublication {
  const errors: string[] = [];
  const warnings: string[] = [];
  const packs = new Map<string, TerritoryPack>();
  for (const [id, snap] of snapshots) {
    if (!snap) {
      errors.push(`non puoi leggere il territorio ${id}`);
      continue;
    }
    let pack: TerritoryPack;
    try {
      pack = snapshotToPack(snap, virtualDir(id));
    } catch (e) {
      const issues = e instanceof SnapshotError ? e.issues.map((i) => `${i.file} ${i.item}: ${i.message}`) : [String(e)];
      errors.push(...issues.map((i) => `${id}: ${i}`));
      continue;
    }
    // Media: si pubblicano solo quelli con i file nel bucket e con l'impronta registrata.
    const usable = pack.media.filter((m) => {
      const raw = ((snap.media ?? []) as SnapshotMedia[]).find((r) => r.id === m.id);
      const data = files.get(`${id}/${m.file}`);
      const missing = [m.file, ...(m.poster ? [m.poster] : [])].filter((f) => !files.has(`${id}/${f}`));
      if (missing.length > 0) {
        (id === target ? errors : warnings).push(`${id}: foto ${m.id}, file ${missing.join(", ")} non presente nel bucket media`);
        return false;
      }
      if (raw?.sha256 && data && sha256(data) !== raw.sha256) {
        errors.push(`${id}: foto ${m.id}, il file nel bucket non corrisponde all'impronta registrata`);
        return false;
      }
      if (m.kind !== "video" && data && data.byteLength > LARGE_IMAGE_BYTES) {
        warnings.push(`${id}: foto ${m.id} pesa ${(data.byteLength / 1024 / 1024).toFixed(1)} MB: rallenta lo scaricamento offline (ricaricala dallo Studio, che la riduce)`);
      }
      return true;
    });
    packs.set(id, { ...pack, media: usable });
  }
  const dest = packs.get(target);
  if (!dest) errors.push(`territorio ${target} non leggibile`);
  else if (dest.manifest.kind !== "destination") errors.push(`${target} è un contenitore: si pubblicano le destinazioni`);
  if (errors.length > 0 || !dest) return { ok: false, errors, warnings, bundles: [] };

  const readAsset = (packDir: string, relativePath: string): Uint8Array => {
    const file = relativePath.slice(MEDIA_FILES_DIR.length + 1);
    const data = files.get(`${packIdOf(packDir)}/${file}`);
    if (!data) throw new BundleBuildError(`file ${file} mancante`);
    return data;
  };

  // Per il validatore i file stanno nella cartella virtuale del pack: esistono se sono tra quelli scaricati.
  const fileExists = (path: string) => {
    const m = /^\/studio-db\/([^/]+)\/media\/files\/(.+)$/.exec(path);
    return !!m && files.has(`${m[1]}/${m[2]}`);
  };

  const bundles: PublicationBundle[] = [];
  for (const locale of dest.manifest.locales) {
    try {
      const built = buildBundle(packs, { destination: target, locale: locale as Locale, readAsset, fileExists });
      const manifestJson = String(built.files.get("manifest.json"));
      const immutable = new Map([...built.files].filter(([p]) => p !== "manifest.json").map(([p, d]) => [p, typeof d === "string" ? new TextEncoder().encode(d) : d]));
      bundles.push({
        locale,
        folder: bundleFolder(target, locale),
        manifest: built.manifest,
        entry: indexEntry(built.content, pubBase(target, locale)),
        places: built.content.places.length,
        units: built.content.units.length,
        immutable,
        stream: built.streamFiles,
        manifestJson,
      });
    } catch (e) {
      errors.push(`${target} (${locale}): ${e instanceof BundleBuildError ? e.message : String(e)}`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, bundles: errors.length === 0 ? bundles : [] };
}
