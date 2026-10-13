/**
 * File media dei territori nati dai file del repository: import_pack() porta nel database autore, licenza,
 * luoghi e impronta, ma i file restano in territories/<pack>/media/files. Questa funzione li copia nel bucket
 * «media», così lo Studio li mostra e la pubblicazione li trova. Si copia solo un file identico a quello
 * registrato (stessa impronta sha256), con la sessione di chi lo chiede (policy di Storage).
 * I file arrivano nella funzione del server con outputFileTracingIncludes (next.config.ts). I percorsi qui sotto sono
 * esclusi dall'analisi di Turbopack (turbopackIgnore): calcolati a runtime, gli farebbero includere tutto il progetto.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MEDIA_FILES_DIR } from "@guide/domain";
import { MEDIA_BUCKET } from "./shared";

/** Cartella territories/ del repository, se presente accanto all'app (sviluppo, build, funzioni Vercel). */
export function territoriesRoot(cwd: string = process.cwd()): string | null {
  for (const up of ["", "../..", ".."]) {
    const candidate = join(/*turbopackIgnore: true*/ cwd, up, "territories");
    if (existsSync(/*turbopackIgnore: true*/ candidate)) return candidate;
  }
  return null;
}

/** Cartella del pack: territories/<id> o un livello sotto (per esempio territories/_synthetic/<id>). */
export function packDir(root: string, pack: string): string | null {
  if (existsSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ root, pack))) return join(/*turbopackIgnore: true*/ root, pack);
  for (const group of readdirSync(/*turbopackIgnore: true*/ root, { withFileTypes: true })) {
    const dir = join(/*turbopackIgnore: true*/ root, group.name, pack);
    if (group.isDirectory() && existsSync(/*turbopackIgnore: true*/ dir)) return dir;
  }
  return null;
}

export interface RepoMediaResult {
  copied: string[];
  /** File non trovati nel repository (o in una versione diversa da quella registrata). */
  missing: string[];
  failed: string[];
}

const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4", webm: "video/webm" };

export async function copyRepoMedia(
  supabase: SupabaseClient,
  pack: string,
  media: { file: string; poster?: string; sha256?: string }[],
  inBucket: Set<string>,
): Promise<RepoMediaResult> {
  const result: RepoMediaResult = { copied: [], missing: [], failed: [] };
  const root = territoriesRoot();
  const dir = root ? packDir(root, pack) : null;
  for (const m of media) {
    for (const [file, expected] of [[m.file, m.sha256], ...(m.poster ? [[m.poster, undefined] as const] : [])] as const) {
      const path = `${pack}/${file}`;
      if (inBucket.has(path)) continue;
      const local = dir ? join(/*turbopackIgnore: true*/ dir, MEDIA_FILES_DIR, file) : null;
      if (!local || !existsSync(/*turbopackIgnore: true*/ local)) {
        result.missing.push(file);
        continue;
      }
      const data = readFileSync(/*turbopackIgnore: true*/ local);
      if (expected && createHash("sha256").update(data).digest("hex") !== expected) {
        result.missing.push(`${file} (versione diversa da quella registrata)`);
        continue;
      }
      const up = await supabase.storage.from(MEDIA_BUCKET).upload(path, data, {
        contentType: MIME[file.split(".").pop()!.toLowerCase()] ?? "application/octet-stream", upsert: false,
      });
      if (up.error && !/exist|duplicate/i.test(up.error.message)) result.failed.push(`${file}: ${up.error.message}`);
      else result.copied.push(file);
    }
  }
  return result;
}
