/**
 * Indice dei bundle compilati dai file (public/bundles/index.json), letto dal disco dal server.
 * Lo usano le domande all'AI e lo Studio (che non pubblica contenuti a pagamento per le destinazioni che ci sono).
 * Solo server: la root del progetto su Vercel può essere il monorepo o l'app.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BundleIndex, BundleIndexEntry } from "./bundle-index";

export function bundlesDir(): string {
  const app = join(process.cwd(), "public", "bundles");
  return existsSync(app) ? app : join(process.cwd(), "apps", "guide", "public", "bundles");
}

export async function readStaticIndex(dir = bundlesDir()): Promise<BundleIndexEntry[]> {
  const parsed = JSON.parse(await readFile(join(dir, "index.json"), "utf8")) as BundleIndex;
  if (!Array.isArray(parsed?.bundles)) throw new Error("indice dei bundle statici non valido");
  return parsed.bundles;
}

/** Destinazioni con bundle statici; null se l'indice non si legge (chi lo usa deve decidere con prudenza). */
export async function staticDestinations(): Promise<Set<string> | null> {
  try {
    return new Set((await readStaticIndex()).map((e) => e.destination));
  } catch {
    return null;
  }
}
