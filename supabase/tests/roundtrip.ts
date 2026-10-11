/**
 * Prova di parità pack ↔ database (milestone 3), su un Postgres locale con le migrazioni applicate.
 * La lancia run.sh (npm run db:check) con PGHOST/PGPORT/PGUSER/PGDATABASE impostati.
 *
 * Per ogni pack sotto territories/, nell'ordine delle dipendenze:
 *   1. pack → SQL (guide-pack db-sql) → import_pack();
 *   2. pack_snapshot() → pack: deve essere identico all'originale;
 *   3. il pack riscritto come YAML, ricaricato e validato, deve dare gli stessi bundle (byte per byte);
 *   4. reimportare è idempotente; un elemento tolto dal pack sparisce anche dal database.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildBundle } from "@guide/bundle";
import { MEDIA_FILES_DIR, type TerritoryPack } from "@guide/domain";
import {
  diffPacks,
  importSql,
  loadPacks,
  mediaFileInfo,
  packToSnapshot,
  snapshotToPack,
  validatePacks,
  writePackDir,
} from "@guide/territory-pack";

const root = resolve(import.meta.dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "roundtrip-"));
const psql = (args: string[], input?: string) =>
  execFileSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", ...args], { encoding: "utf8", input, maxBuffer: 1 << 28 });
const fail = (message: string): never => {
  console.error(`FALLITO: ${message}`);
  process.exit(1);
};

const original = loadPacks(join(root, "territories"));
if (original.issues.length > 0) fail("i pack di partenza non si caricano");

// Ordine delle dipendenze.
const order: string[] = [];
const visit = (id: string) => {
  if (order.includes(id)) return;
  original.packs.get(id)!.manifest.dependsOn.forEach(visit);
  order.push(id);
};
[...original.packs.keys()].sort().forEach(visit);

const snapshotOf = (pack: TerritoryPack) =>
  packToSnapshot(pack, (file) => mediaFileInfo(readFileSync(join(pack.dir, MEDIA_FILES_DIR, file))));
const importPack = (snapshot: Record<string, unknown>) => {
  const file = join(work, "import.sql");
  writeFileSync(file, importSql(snapshot));
  psql(["-f", file]);
};
const readBack = (id: string) => JSON.parse(psql(["-c", `select pack_snapshot('${id}')`])) as Record<string, unknown>;

// Come nel progetto reale: i pack nuovi vanno all'organizzazione della piattaforma.
psql(["-c", "insert into organizations (kind, name) values ('platform', 'Piattaforma di prova')"]);

const exported = new Map<string, TerritoryPack>();
for (const id of order) {
  const pack = original.packs.get(id)!;
  importPack(snapshotOf(pack));
  const snapshot = readBack(id);
  // Il pack riletto usa i file media dell'originale (in produzione arrivano da Storage).
  const back = snapshotToPack(snapshot, pack.dir);
  const diff = diffPacks(pack, back);
  if (diff.length > 0) fail(`${id} cambia passando dal database:\n  ${diff.slice(0, 20).join("\n  ")}`);

  // Idempotenza: reimportare non cambia nulla.
  importPack(snapshotOf(pack));
  if (JSON.stringify(readBack(id)) !== JSON.stringify(snapshot)) fail(`${id}: reimportare cambia il database`);

  // Scritto come YAML e ricaricato: stesso pack.
  const dir = join(work, "packs", id);
  writePackDir(back, dir);
  // I file media arrivano da Storage; qui dalla cartella originale.
  if (back.media.length > 0) cpSync(join(pack.dir, MEDIA_FILES_DIR), join(dir, MEDIA_FILES_DIR), { recursive: true });
  exported.set(id, { ...back, dir });
  console.log(`✓ ${id}: luoghi ${back.places.length}, affermazioni ${back.assertions.length}, unità ${back.units.length}, percorsi ${back.routes.length}, media ${back.media.length}`);
}

const reloaded = loadPacks(join(work, "packs"));
if (reloaded.issues.length > 0) fail(`i pack esportati non si rileggono: ${reloaded.issues.map((i) => i.message).join("; ")}`);
// Stessi errori e avvisi; negli elenchi dei messaggi conta il contenuto, non l'ordine dei file.
const issueKey = (i: { level: string; code: string; packId: string; message: string }) =>
  `${i.level} ${i.code} ${i.packId} ${i.message.split(/[\s,:+]+/).sort().join(" ")}`;
const before = validatePacks(original.packs).map(issueKey).sort();
const after = validatePacks(reloaded.packs).map(issueKey).sort();
if (JSON.stringify(before) !== JSON.stringify(after)) {
  fail(`il validatore dà esiti diversi sui pack esportati:\n  prima: ${before.filter((x) => !after.includes(x)).join("\n  prima: ")}\n  dopo: ${after.filter((x) => !before.includes(x)).join("\n  dopo: ")}`);
}
for (const [id, pack] of reloaded.packs) {
  const diff = diffPacks(original.packs.get(id)!, pack);
  if (diff.length > 0) fail(`${id} cambia passando dai file YAML esportati:\n  ${diff.slice(0, 20).join("\n  ")}`);
}

// Bundle: stessi byte. I media si leggono dalle cartelle originali (gli stessi file di Storage).
const assetDir = new Map<string, string>([
  ...[...original.packs.values()].map((p) => [p.dir, p.dir] as const),
  ...[...reloaded.packs].map(([id, p]) => [p.dir, original.packs.get(id)!.dir] as const),
]);
const readAsset = (packDir: string, path: string) => new Uint8Array(readFileSync(join(assetDir.get(packDir)!, path)));
let bundles = 0;
for (const pack of original.packs.values()) {
  if (pack.manifest.kind !== "destination") continue;
  for (const locale of pack.manifest.locales) {
    for (const flavor of ["full", "lite"] as const) {
      const options = { destination: pack.manifest.id, locale, flavor, allowFictional: true, readAsset };
      const a = buildBundle(original.packs, options);
      const b = buildBundle(reloaded.packs, options);
      if (a.manifest.kbHash !== b.manifest.kbHash) fail(`${pack.manifest.id} ${locale}-${flavor}: kbHash diverso`);
      if (JSON.stringify(a.manifest) !== JSON.stringify(b.manifest)) fail(`${pack.manifest.id} ${locale}-${flavor}: manifest diverso`);
      if (JSON.stringify(a.content) !== JSON.stringify(b.content)) fail(`${pack.manifest.id} ${locale}-${flavor}: contenuti diversi`);
      bundles++;
    }
  }
}
console.log(`✓ ${bundles} bundle identici (manifest, kbHash e contenuti) prima e dopo il database`);

// Rimozione: un'unità tolta dal pack sparisce dal database; poi si ripristina.
const target = [...original.packs.values()].find((p) => p.units.length > 1)!;
const full = snapshotOf(target);
const units = full.units as { id: string }[];
importPack({ ...full, units: units.slice(0, -1) });
const count = (readBack(target.manifest.id).units as unknown[]).length;
if (count !== units.length - 1) fail(`un'unità tolta dal pack resta nel database (${count} invece di ${units.length - 1})`);
importPack(full);
if ((readBack(target.manifest.id).units as unknown[]).length !== units.length) fail("ripristino dell'unità tolta");
console.log("✓ reimportare è idempotente e ciò che si toglie dal pack si toglie dal database");

rmSync(work, { recursive: true, force: true });
