/**
 * Scambio tra Territory Pack e database (milestone 3 della piattaforma).
 *
 * L'«istantanea» è il contenuto dei file YAML di un pack in un unico oggetto JSON, con i riferimenti
 * ai nodi sempre completi («pack:slug»). La funzione SQL import_pack() la scrive nel database e
 * pack_snapshot() la rilegge (supabase/migrations/20261016000000_pack_import_export.sql).
 *
 *   pack → packToSnapshot → import_pack → database → pack_snapshot → snapshotToPack → pack
 *
 * Il viaggio di andata e ritorno deve restituire lo stesso pack e lo stesso bundle:
 * lo prova supabase/tests/roundtrip.ts.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatNodeRef, PACK_FILES, resolveRef, type TerritoryPack } from "@guide/domain";
import { stringify } from "yaml";

/** Dati di un file media che il database conserva accanto ai metadati. */
export interface MediaFileInfo {
  sha256: string;
  bytes: number;
}

type Json = Record<string, unknown>;
type RefMap = (ref: string) => string;

const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4", webm: "video/webm" };

/** Applica `map` a tutti i campi del pack che contengono un riferimento a un nodo o a una fonte. */
function mapRefs(pack: Omit<TerritoryPack, "dir">, map: RefMap): Omit<TerritoryPack, "dir"> {
  return {
    ...pack,
    places: pack.places.map((p) => ({
      ...p,
      ...(p.partOf ? { partOf: map(p.partOf) } : {}),
      practical: p.practical.map((i) => ({ ...i, ...(i.source ? { source: map(i.source) } : {}) })),
    })),
    assertions: pack.assertions.map((a) => ({
      ...a,
      subject: map(a.subject),
      ...(a.object ? { object: map(a.object) } : {}),
      evidence: a.evidence.map((e) => ({ ...e, source: map(e.source) })),
    })),
    units: pack.units.map((u) => ({
      ...u,
      anchor: map(u.anchor),
      introduces: u.introduces.map(map),
      requires: u.requires.map(map),
      hooks: u.hooks.map((h) => ({ ...h, target: map(h.target) })),
    })),
    routes: pack.routes.map((r) => ({
      ...r,
      sources: r.sources.map(map),
      stops: r.stops.map((s) => ({ ...s, place: map(s.place) })),
    })),
    media: pack.media.map((m) => ({ ...m, subjects: m.subjects.map(map) })),
  };
}

const fullRefs = (packId: string): RefMap => (ref) => formatNodeRef(resolveRef(ref, packId)!);
/** Nello stesso pack basta lo slug, come si scrive a mano. */
const localRefs = (packId: string): RefMap => (ref) => {
  const r = resolveRef(ref, packId)!;
  return r.packId === packId ? r.slug : formatNodeRef(r);
};

/** Pack → istantanea per import_pack(). `files` dà impronta e dimensione dei file media (per nome). */
export function packToSnapshot(pack: TerritoryPack, files: (file: string) => MediaFileInfo): Json {
  const { dir: _dir, ...rest } = pack;
  const mapped = mapRefs(rest, fullRefs(pack.manifest.id));
  return {
    ...mapped,
    media: mapped.media.map((m) => {
      const info = files(m.file);
      return { ...m, sha256: info.sha256, bytes: info.bytes, mimeType: MIME[m.file.split(".").pop()!.toLowerCase()] };
    }),
  };
}

export class SnapshotError extends Error {
  constructor(readonly issues: { file: string; item: string; message: string }[]) {
    super(`istantanea non valida:\n${issues.map((i) => `  ${i.file} ${i.item}: ${i.message}`).join("\n")}`);
    this.name = "SnapshotError";
  }
}

/**
 * Istantanea letta dal database (pack_snapshot()) → pack, validato con gli stessi schemi dei file YAML.
 * `dir` è la cartella da attribuire al pack (per leggere i file media).
 */
export function snapshotToPack(snapshot: Json, dir: string): TerritoryPack {
  const parsed: Record<string, unknown> = {};
  const issues: { file: string; item: string; message: string }[] = [];
  for (const [key, { path, schema }] of Object.entries(PACK_FILES)) {
    let raw = snapshot[key] ?? (key === "manifest" || key === "config" ? {} : []);
    // Campi che esistono solo nel database.
    if (key === "media") raw = (raw as Json[]).map(({ sha256: _s, bytes: _b, mimeType: _m, ...m }) => m);
    const result = schema.safeParse(raw);
    if (result.success) parsed[key] = result.data;
    else for (const issue of result.error.issues) issues.push({ file: path, item: issue.path.join("."), message: issue.message });
  }
  if (issues.length > 0) throw new SnapshotError(issues);
  const pack = parsed as unknown as Omit<TerritoryPack, "dir">;
  return { dir, ...mapRefs(pack, localRefs(pack.manifest.id)) };
}

/**
 * Istruzione SQL che importa il pack: un solo comando, quindi tutto o niente.
 * Si incolla nel SQL Editor di Supabase (o si passa a psql).
 */
export function importSql(snapshot: Json): string {
  const json = JSON.stringify(snapshot);
  let tag = "pack";
  while (json.includes(`$${tag}$`)) tag += "_";
  return `select import_pack($${tag}$${json}$${tag}$::jsonb);\n`;
}

/** Impronta e dimensione di un file. */
export function mediaFileInfo(data: Uint8Array): MediaFileInfo {
  return { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.byteLength };
}

/** Scrive il pack come cartella di file YAML (solo i file con contenuto, più pack.yaml e config.yaml). */
export function writePackDir(pack: TerritoryPack, dir: string): string[] {
  const written: string[] = [];
  for (const [key, { path }] of Object.entries(PACK_FILES)) {
    const value = pack[key as keyof typeof PACK_FILES];
    if (Array.isArray(value) && value.length === 0) continue;
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, stringify(value, { lineWidth: 0 }));
    written.push(path);
  }
  return written;
}

/**
 * Confronta due pack campo per campo, con i riferimenti normalizzati e gli elenchi principali
 * ordinati per id (l'ordine dei file YAML non ha significato; quello degli elenchi interni sì).
 */
export function diffPacks(a: TerritoryPack, b: TerritoryPack): string[] {
  const norm = (p: TerritoryPack) => {
    const { dir: _dir, ...rest } = p;
    const m = mapRefs(rest, fullRefs(p.manifest.id)) as unknown as Record<string, unknown>;
    for (const key of Object.keys(PACK_FILES)) {
      if (Array.isArray(m[key])) m[key] = [...(m[key] as Json[])].sort((x, y) => String(x.id).localeCompare(String(y.id)));
    }
    return m;
  };
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) out.push(`${path}: ${x.length} elementi invece di ${y.length}`);
      for (let i = 0; i < Math.min(x.length, y.length); i++) walk(x[i], y[i], `${path}[${(x[i] as Json)?.id ?? i}]`);
      return;
    }
    if (x && y && typeof x === "object" && typeof y === "object") {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of [...keys].sort()) walk((x as Json)[k], (y as Json)[k], `${path}.${k}`);
      return;
    }
    if (x !== y) out.push(`${path}: ${JSON.stringify(x)} ≠ ${JSON.stringify(y)}`);
  };
  walk(norm(a), norm(b), a.manifest.id);
  return out;
}
