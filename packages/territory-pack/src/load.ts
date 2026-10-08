import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { PACK_FILES, type TerritoryPack } from "@guide/domain";
import { parse } from "yaml";
import { IssueCollector, type PackIssue } from "./issues.ts";

export interface LoadResult {
  packs: Map<string, TerritoryPack>;
  issues: PackIssue[];
}

/** Trova ricorsivamente tutte le cartelle che contengono un pack.yaml. */
export function discoverPackDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    if (existsSync(join(dir, PACK_FILES.manifest.path))) {
      found.push(dir);
      return;
    }
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
    }
  };
  walk(root);
  return found.sort();
}

function readYaml(path: string): unknown {
  return parse(readFileSync(path, "utf8"));
}

/** Carica un singolo pack. Restituisce null se il manifest è assente o non valido. */
export function loadPack(dir: string, collector: IssueCollector): TerritoryPack | null {
  const fallbackId = basename(dir);
  const loaded: Record<string, unknown> = {};

  for (const [key, { path, schema }] of Object.entries(PACK_FILES)) {
    const full = join(dir, path);
    if (!existsSync(full)) {
      if (key === "manifest") {
        collector.error({ code: "MANIFEST_MISSING", packId: fallbackId, file: path, message: "pack.yaml mancante" });
        return null;
      }
      continue;
    }
    let raw: unknown;
    try {
      // Un file YAML vuoto vale come lista vuota / oggetto vuoto.
      raw = readYaml(full) ?? (key === "manifest" || key === "config" ? {} : []);
    } catch (err) {
      collector.error({
        code: "YAML_PARSE",
        packId: fallbackId,
        file: path,
        message: `YAML non leggibile: ${(err as Error).message}`,
      });
      continue;
    }
    const result = schema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) {
        collector.error({
          code: "SCHEMA",
          packId: fallbackId,
          file: path,
          item: issue.path.join("."),
          message: issue.message,
        });
      }
      if (key === "manifest") return null;
      continue;
    }
    loaded[key] = result.data;
  }

  const config = loaded.config ?? PACK_FILES.config.schema.parse({});
  return {
    dir,
    manifest: loaded.manifest as TerritoryPack["manifest"],
    config: config as TerritoryPack["config"],
    places: (loaded.places ?? []) as TerritoryPack["places"],
    anchors: (loaded.anchors ?? []) as TerritoryPack["anchors"],
    nodes: (loaded.nodes ?? []) as TerritoryPack["nodes"],
    sources: (loaded.sources ?? []) as TerritoryPack["sources"],
    assertions: (loaded.assertions ?? []) as TerritoryPack["assertions"],
    units: (loaded.units ?? []) as TerritoryPack["units"],
    routes: (loaded.routes ?? []) as TerritoryPack["routes"],
    media: (loaded.media ?? []) as TerritoryPack["media"],
  };
}

/** Carica tutti i pack sotto `root`. */
export function loadPacks(root: string): LoadResult {
  const collector = new IssueCollector();
  const packs = new Map<string, TerritoryPack>();
  for (const dir of discoverPackDirs(root)) {
    const pack = loadPack(dir, collector);
    if (!pack) continue;
    const id = pack.manifest.id;
    if (packs.has(id)) {
      collector.error({
        code: "DUPLICATE_PACK",
        packId: id,
        message: `pack duplicato: ${relative(root, packs.get(id)!.dir)} e ${relative(root, dir)}`,
      });
      continue;
    }
    packs.set(id, pack);
  }
  return { packs, issues: collector.issues };
}
