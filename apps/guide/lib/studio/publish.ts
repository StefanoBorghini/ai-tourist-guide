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
import { buildBundle, BundleBuildError, type BundleManifest, type PremiumFile } from "@guide/bundle";
import { MEDIA_FILES_DIR, type Locale, type TerritoryPack } from "@guide/domain";
import { SnapshotError, snapshotToPack } from "@guide/territory-pack";
import { bundleFolder, indexEntry, manifestPublication, pubBase, type BundleIndexEntry } from "../bundle-index";
import { premiumBlockedByStatic } from "../static-bundles";

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
  /** Manifest: si carica per ultimo, dopo tutti gli altri file. */
  manifestJson: string;
  /** Percorso del manifest nella cartella del bundle: `<id pubblicazione>/manifest.json` (o `manifest.json`). */
  manifestPath: string;
  /** Il bundle esclude contenuti a pagamento: le versioni precedenti del contenuto vanno tolte dal bucket. */
  locked: boolean;
  /** Parti a pagamento per il bucket privato «premium», per percorso nel bucket (solo con una pubblicazione). */
  premium: Map<string, Uint8Array>;
}

export { PREMIUM_BUCKET } from "../premium";
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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
 * @param staticDestinations  destinazioni con bundle compilati dai file (null: elenco non leggibile). Con
 *   contenuti a pagamento la pubblicazione si rifiuta se la destinazione ha anche bundle statici, o se non si sa
 * @param publication  identificativo della pubblicazione (R2): manifest e contenuti vanno nella sua cartella
 *   (`<lingua>-full/<id>/`), i media restano condivisi in `<lingua>-full/media/`. I percorsi del manifest restano
 *   relativi alla cartella della lingua (`<id>/content.….json`, `media/…`), così il contenuto non cambia.
 */
export function compilePublication(
  target: string,
  snapshots: Map<string, Snapshot | null>,
  files: Map<string, Uint8Array>,
  staticDestinations: ReadonlySet<string> | null = new Set(),
  publication?: string,
): CompiledPublication {
  if (publication !== undefined && !PUBLICATION_ID.test(publication)) {
    return { ok: false, errors: [`identificativo di pubblicazione non valido: ${publication}`], warnings: [], bundles: [] };
  }
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
      const blocked = built.content.locked ? premiumBlockedByStatic(target, staticDestinations) : null;
      if (blocked) {
        errors.push(blocked);
        break;
      }
      let manifest = built.manifest;
      let manifestJson = String(built.files.get("manifest.json"));
      let immutable = new Map([...built.files].filter(([p]) => p !== "manifest.json").map(([p, d]) => [p, typeof d === "string" ? new TextEncoder().encode(d) : d]));
      let entry = indexEntry(built.content, pubBase(target, locale));
      let manifestPath = "manifest.json";
      if (publication) {
        // Il contenuto nella cartella della pubblicazione; media e copertine restano dove sono (condivisi).
        const content = `${publication}/${built.manifest.content}`;
        manifest = { ...built.manifest, content, files: built.manifest.files.map((f) => (f.path === built.manifest.content ? { ...f, path: content } : f)) };
        manifestJson = JSON.stringify(manifest, null, 2);
        immutable = new Map([...immutable].map(([p, d]) => [p === built.manifest.content ? content : p, d]));
        manifestPath = `${publication}/manifest.json`;
        entry = { ...entry, manifest: `${pubBase(target, locale)}${manifestPath}` };
      }
      // Parti a pagamento: nel bucket privato, cartella della pubblicazione; il manifest pubblico ne elenca solo
      // nomi e impronte. Senza identificativo di pubblicazione (prove) non c'è una cartella in cui metterle.
      const premium = new Map<string, Uint8Array>();
      if (publication && built.premium.length > 0) {
        const listed: PremiumFile[] = [];
        for (const part of built.premium) {
          const slug = part.ref ? part.ref.slice(part.ref.lastIndexOf(":") + 1) : "";
          if (part.kind !== "explore" && !SLUG.test(slug)) {
            throw new BundleBuildError(`${part.kind === "route" ? "percorso" : "luogo"} a pagamento con un identificativo non valido: ${part.ref}`);
          }
          const data = new TextEncoder().encode(JSON.stringify(part));
          const hash = sha256(data);
          const path = `${target}/${locale}/${publication}/${part.kind === "explore" ? "explore" : `${part.kind}-${slug}`}.${hash.slice(0, 16)}.json`;
          premium.set(path, data);
          listed.push({ kind: part.kind, ...(part.ref ? { ref: part.ref } : {}), path, sha256: hash, bytes: data.byteLength });
        }
        manifest = { ...manifest, premium: listed };
        manifestJson = JSON.stringify(manifest, null, 2);
      }
      bundles.push({
        locale,
        folder: bundleFolder(target, locale),
        manifest,
        entry,
        places: built.content.places.length,
        units: built.content.units.length,
        immutable,
        stream: built.streamFiles,
        manifestJson,
        manifestPath,
        locked: built.content.locked !== undefined,
        premium,
      });
    } catch (e) {
      errors.push(`${target} (${locale}): ${e instanceof BundleBuildError ? e.message : String(e)}`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, bundles: errors.length === 0 ? bundles : [] };
}

const PUBLICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTENT_FILE = /^content\.[0-9a-f]{8,64}\.json$/;
const PUBLICATION_FILE = /^(manifest\.json|content\.[0-9a-f]{8,64}\.json)$/;

/** Il minimo del client Storage che serve alla pulizia (così la si prova senza rete). */
export interface CleanupBucket {
  list(path: string, options: { limit: number }): Promise<{ data: { name: string }[] | null; error: { message: string } | null }>;
  remove(paths: string[]): Promise<{ error: { message: string } | null }>;
}

/**
 * Pulizia dopo una pubblicazione andata in linea (R2). Per ogni cartella di lingua cancella:
 * - le cartelle delle pubblicazioni «morte» (`deadPublications`: fallite, o pubblicate e già sostituite);
 * - i contenuti della struttura precedente (`<lingua>-full/content.*.json`), se in linea c'è già una pubblicazione
 *   nella struttura nuova.
 * Mai ciò che usa l'indice in vigore (`visible`, letto dal bucket), e niente del tutto se l'indice in vigore non è
 * ancora quello di questa pubblicazione (`ownPublication`): in quel caso i file restano, orfani, alla prossima.
 * Entrambe le condizioni, una volta vere, restano vere per sempre (una pubblicazione morta non torna in linea, e
 * l'indice servito va solo avanti): una pulizia tardiva, di un processo rimasto sospeso, non tocca la versione in
 * linea. Il bucket lo impone a sua volta (policy di cancellazione, 20261023000000).
 * Restituisce gli avvisi.
 */
export async function removeDeadVersions(
  bucket: CleanupBucket,
  folders: readonly string[],
  visible: readonly BundleIndexEntry[],
  deadPublications: readonly string[],
  ownPublication: string,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const folder of folders) {
    const entry = visible.find((e) => e.manifest.startsWith(`/pub/${folder}/`));
    const inUse = entry ? manifestPublication(entry.manifest) : null;
    if (!entry || inUse !== ownPublication) {
      warnings.push(`${folder}: versioni precedenti non cancellate (l'indice in vigore non è ancora quello di questa pubblicazione)`);
      continue;
    }
    const doomed: string[] = [];
    for (const id of deadPublications) {
      if (id === inUse || !PUBLICATION_ID.test(id)) continue;
      const { data, error } = await bucket.list(`${folder}/${id}`, { limit: 1000 });
      if (error) warnings.push(`${folder}/${id}: elenco non disponibile (${error.message})`);
      for (const f of data ?? []) if (PUBLICATION_FILE.test(f.name)) doomed.push(`${folder}/${id}/${f.name}`);
    }
    const { data, error } = await bucket.list(folder, { limit: 1000 });
    if (error) warnings.push(`${folder}: elenco non disponibile (${error.message})`);
    for (const f of data ?? []) if (CONTENT_FILE.test(f.name)) doomed.push(`${folder}/${f.name}`);
    if (doomed.length === 0) continue;
    const removed = await bucket.remove(doomed);
    if (removed.error) warnings.push(`${folder}: versioni precedenti non cancellate (${removed.error.message})`);
  }
  return warnings;
}

/**
 * Pulizia del bucket «premium» dopo una pubblicazione andata in linea: le cartelle delle pubblicazioni morte del
 * territorio, con le stesse cautele dei bundle (niente se l'indice in vigore non è ancora quello di questa
 * pubblicazione). Il bucket lo impone a sua volta (policy di cancellazione, 20261027000000).
 */
export async function removeDeadPremium(
  bucket: CleanupBucket,
  pack: string,
  locales: readonly string[],
  visible: readonly BundleIndexEntry[],
  deadPublications: readonly string[],
  ownPublication: string,
): Promise<string[]> {
  const warnings: string[] = [];
  const doomed: string[] = [];
  for (const locale of locales) {
    const entry = visible.find((e) => e.manifest.startsWith(`/pub/${bundleFolder(pack, locale)}/`));
    if (!entry || manifestPublication(entry.manifest) !== ownPublication) continue;
    for (const id of deadPublications) {
      if (id === ownPublication || !PUBLICATION_ID.test(id)) continue;
      const { data, error } = await bucket.list(`${pack}/${locale}/${id}`, { limit: 1000 });
      if (error) warnings.push(`premium ${pack}/${locale}/${id}: elenco non disponibile (${error.message})`);
      for (const f of data ?? []) if (PREMIUM_FILE.test(f.name)) doomed.push(`${pack}/${locale}/${id}/${f.name}`);
    }
  }
  if (doomed.length > 0) {
    const removed = await bucket.remove(doomed);
    if (removed.error) warnings.push(`premium: versioni precedenti non cancellate (${removed.error.message})`);
  }
  return warnings;
}
const PREMIUM_FILE = /^(explore|(route|place)-[a-z0-9]+(-[a-z0-9]+)*)\.[0-9a-f]{16,64}\.json$/;
