#!/usr/bin/env -S npx tsx
/**
 * guide-pack — strumento a riga di comando per i Territory Pack.
 *
 *   guide-pack validate <cartella> [--pack <id>] [--strict] [--json]
 *   guide-pack photos <cartella-foto> [--territories <cartella-pack> --pack <id>]
 *   guide-pack field <rilievi.json> --territories <cartella-pack>
 *   guide-pack db-sql <cartella> --pack <id> [--out <file.sql>]
 *   guide-pack db-export <istantanea.json> --out <cartella> [--media <cartella-media>]
 *
 * "db-sql" scrive l'SQL che importa il pack (e i pack da cui dipende) nel database: si esegue nel
 * SQL Editor di Supabase. "db-export" fa il contrario: dall'istantanea letta con pack_snapshot()
 * ricrea la cartella del pack (i file media si copiano a parte, da Storage o da --media).
 *
 * "field" legge i rilievi esportati dall'app e stampa proposte per luogo: non modifica il pack.
 *
 * Carica tutti i pack sotto <cartella> (per risolvere le dipendenze),
 * li valida e stampa errori e avvisi. Esce con codice 1 se ci sono errori
 * (o avvisi, con --strict).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MEDIA_FILES_DIR } from "@guide/domain";
import { importSql, mediaFileInfo, packToSnapshot, snapshotToPack, writePackDir } from "./db.ts";
import { argv, cwd, exit, stdout } from "node:process";
import { hasErrors, type PackIssue } from "./issues.ts";
import { loadPacks } from "./load.ts";
import { fieldReport } from "./field-report.ts";
import { metersBetween } from "./geo.ts";
import { readPhotoLocation } from "./photo-location.ts";
import { summarizePack } from "./summary.ts";
import { validatePacks } from "./validate.ts";

function usage(): never {
  stdout.write(
    "Uso:\n  guide-pack validate <cartella> [--pack <id>] [--strict] [--json]\n" +
      "  guide-pack photos <cartella-foto> [--territories <cartella-pack> --pack <id>]\n" +
      "  guide-pack field <rilievi.json> --territories <cartella-pack>\n" +
      "  guide-pack db-sql <cartella> --pack <id> [--out <file.sql>]\n" +
      "  guide-pack db-export <istantanea.json> --out <cartella> [--media <cartella-media>]\n",
  );
  exit(2);
}

/** Legge la posizione GPS delle foto e, se indicato un pack, trova il luogo più vicino. */
function photos(dirArg: string, rest: string[]): number {
  const base = process.env.INIT_CWD ?? cwd();
  const dir = resolve(base, dirArg);
  const territoriesIndex = rest.indexOf("--territories");
  const packIndex = rest.indexOf("--pack");
  const places =
    territoriesIndex >= 0 && packIndex >= 0
      ? (loadPacks(resolve(base, rest[territoriesIndex + 1]!)).packs.get(rest[packIndex + 1]!)?.places ?? [])
      : [];
  const files = readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort();
  if (files.length === 0) stdout.write(`Nessuna foto JPEG in ${dir}\n`);
  for (const f of files) {
    const info = readPhotoLocation(new Uint8Array(readFileSync(join(dir, f))));
    if (!info) {
      stdout.write(`✗ ${f}: nessuna posizione GPS (localizzazione disattivata o foto modificata)\n`);
      continue;
    }
    const [lng, lat] = info.location;
    const nearest = places
      .map((p) => ({ id: p.id, d: metersBetween(info.location, p.location) }))
      .sort((a, b) => a.d - b.d)[0];
    stdout.write(
      `✓ ${f}: [${lng}, ${lat}]${info.altitudeM !== undefined ? ` · ${info.altitudeM} m` : ""}` +
        `${info.takenAt ? ` · ${info.takenAt}` : ""}` +
        `${nearest ? ` · luogo più vicino: ${nearest.id} (${Math.round(nearest.d)} m)` : ""}\n`,
    );
  }
  return 0;
}

/** Rivede un file di rilievi: proposte per luogo, mai scritte nel pack. */
function field(fileArg: string, rest: string[]): number {
  const base = process.env.INIT_CWD ?? cwd();
  const territoriesIndex = rest.indexOf("--territories");
  if (territoriesIndex < 0) usage();
  const raw = JSON.parse(readFileSync(resolve(base, fileArg), "utf8")) as { destination?: string };
  const pack = loadPacks(resolve(base, rest[territoriesIndex + 1]!)).packs.get(raw.destination ?? "");
  if (!pack) {
    stdout.write(`✗ destinazione del file non trovata tra i pack: ${raw.destination}\n`);
    return 1;
  }
  const r = fieldReport(raw, pack);
  stdout.write(`Rilievi per ${r.destination}: ${r.totalPoints} punti, ${r.simulatedIgnored} simulati ignorati\n`);
  stdout.write("PROPOSTE da rivedere: il pack NON viene modificato.\n\n");
  for (const p of r.places) {
    stdout.write(`■ ${p.name} (${p.poiId}) · pack [${p.packLocation.join(", ")}], raggio ${p.packRadiusM ?? "–"} m\n`);
    if (p.proposedLocation) {
      stdout.write(`  proposta: location [${p.proposedLocation.join(", ")}] · scostamento ${p.offsetM} m · ${p.positions} rilievi, migliore ±${p.bestAccuracyM} m\n`);
    }
    if (p.proposedRadiusM !== null) stdout.write(`  raggio proposto: ${p.proposedRadiusM} m\n`);
    for (const w of p.warnings) stdout.write(`  ⚠ ${w}\n`);
    for (const n of p.notes) stdout.write(`  · ${n}\n`);
  }
  if (r.unknownPlaces.length) stdout.write(`\n⚠ luoghi sconosciuti nel file: ${r.unknownPlaces.join(", ")}\n`);
  for (const n of r.freeNotes) stdout.write(`\nnota libera [${n.lon}, ${n.lat}]: ${n.note ?? ""}\n`);
  return 0;
}

const option = (rest: string[], name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

/** SQL di importazione del pack e delle sue dipendenze, nell'ordine giusto. Solo pack senza errori. */
function dbSql(rootArg: string, rest: string[]): number {
  const base = process.env.INIT_CWD ?? cwd();
  const packId = option(rest, "--pack");
  if (!packId) usage();
  const loaded = loadPacks(resolve(base, rootArg));
  const order: string[] = [];
  const visit = (id: string) => {
    if (order.includes(id)) return;
    const pack = loaded.packs.get(id);
    if (!pack) throw new Error(`pack non trovato: ${id}`);
    pack.manifest.dependsOn.forEach(visit);
    order.push(id);
  };
  visit(packId);
  const errors = [...loaded.issues, ...validatePacks(loaded.packs)].filter((i) => i.level === "error" && order.includes(i.packId));
  if (errors.length > 0) {
    for (const e of errors) stdout.write(`ERRORE [${e.code}] ${e.packId}: ${e.message}\n`);
    stdout.write("✗ il pack non è valido: niente SQL (correggere prima gli errori)\n");
    return 1;
  }
  const sql = order.map((id) => {
    const pack = loaded.packs.get(id)!;
    const snapshot = packToSnapshot(pack, (file) => mediaFileInfo(readFileSync(join(pack.dir, MEDIA_FILES_DIR, file))));
    return `-- ${id} ${pack.manifest.version}\n${importSql(snapshot)}`;
  }).join("\n");
  const out = option(rest, "--out");
  if (out) {
    writeFileSync(resolve(base, out), sql);
    stdout.write(`✓ ${resolve(base, out)}: ${order.join(" → ")}\n`);
  } else {
    stdout.write(sql);
  }
  return 0;
}

/** Istantanea del database → cartella del pack. */
function dbExport(fileArg: string, rest: string[]): number {
  const base = process.env.INIT_CWD ?? cwd();
  const out = option(rest, "--out");
  if (!out) usage();
  const dir = resolve(base, out);
  const snapshot = JSON.parse(readFileSync(resolve(base, fileArg), "utf8")) as Record<string, unknown>;
  const pack = snapshotToPack(snapshot, dir);
  const written = writePackDir(pack, dir);
  const mediaDir = option(rest, "--media");
  let copied = 0;
  if (mediaDir) {
    mkdirSync(join(dir, MEDIA_FILES_DIR), { recursive: true });
    for (const m of pack.media) {
      for (const file of [m.file, ...(m.poster ? [m.poster] : [])]) {
        const from = join(resolve(base, mediaDir), file);
        if (!existsSync(from)) {
          stdout.write(`⚠ file media mancante: ${file}\n`);
          continue;
        }
        copyFileSync(from, join(dir, MEDIA_FILES_DIR, file));
        copied++;
      }
    }
  }
  stdout.write(`✓ ${pack.manifest.id} → ${dir}: ${written.join(", ")}${mediaDir ? ` · ${copied} file media` : ""}\n`);
  return 0;
}

function main(args: string[]): number {
  const [command, rootArg, ...rest] = args;
  if (command === "db-sql" && rootArg) return dbSql(rootArg, rest);
  if (command === "db-export" && rootArg) return dbExport(rootArg, rest);
  if (command === "photos" && rootArg) return photos(rootArg, rest);
  if (command === "field" && rootArg) return field(rootArg, rest);
  if (command !== "validate" || !rootArg) usage();

  const strict = rest.includes("--strict");
  const json = rest.includes("--json");
  const packIndex = rest.indexOf("--pack");
  const onlyPack = packIndex >= 0 ? rest[packIndex + 1] : undefined;
  if (packIndex >= 0 && !onlyPack) usage();

  // Con npm workspaces lo script parte dalla cartella del pacchetto: INIT_CWD è quella di chi lo ha lanciato.
  const root = resolve(process.env.INIT_CWD ?? cwd(), rootArg);
  const loaded = loadPacks(root);
  let issues: PackIssue[] = [...loaded.issues, ...validatePacks(loaded.packs)];
  if (onlyPack) {
    if (!loaded.packs.has(onlyPack)) {
      stdout.write(`Pack non trovato: ${onlyPack}\n`);
      return 1;
    }
    issues = issues.filter((i) => i.packId === onlyPack);
  }
  const packs = [...loaded.packs.values()].filter((p) => !onlyPack || p.manifest.id === onlyPack);

  if (json) {
    stdout.write(`${JSON.stringify({ packs: packs.map(summarizePack), issues }, null, 2)}\n`);
  } else {
    for (const pack of packs) {
      const s = summarizePack(pack);
      const units = Object.entries(s.unitsByLocale).map(([l, n]) => `${l}:${n}`).join(" ") || "0";
      const errors = issues.filter((i) => i.packId === s.id && i.level === "error").length;
      const warnings = issues.filter((i) => i.packId === s.id && i.level === "warning").length;
      stdout.write(
        `${errors ? "✗" : "✓"} ${s.id} ${s.version}${s.fictional ? " [fittizio]" : ""}` +
          `${s.releaseStage !== "production" ? ` [${s.releaseStage}]` : ""} · ${s.kind} · ` +
          `luoghi ${s.places} · nodi ${s.nodes} · fonti ${s.sources} · ` +
          `affermazioni ${s.assertions.verified}/${s.assertions.total} verificate` +
          `${s.assertions.inReview ? `, ${s.assertions.inReview} in revisione` : ""}${s.assertions.draft ? `, ${s.assertions.draft} bozze` : ""} · unità ${units} · percorsi ${s.routes}` +
          ` · ${errors} errori, ${warnings} avvisi\n`,
      );
    }
    for (const issue of issues) {
      const location = [issue.file, issue.item].filter(Boolean).join(" › ");
      stdout.write(
        `  ${issue.level === "error" ? "ERRORE" : "avviso"} [${issue.code}] ${issue.packId}${location ? ` · ${location}` : ""}: ${issue.message}\n`,
      );
    }
    if (packs.length === 0) stdout.write(`Nessun pack trovato in ${root}\n`);
  }

  if (hasErrors(issues)) return 1;
  if (strict && issues.length > 0) return 1;
  return 0;
}

exit(main(argv.slice(2)));
