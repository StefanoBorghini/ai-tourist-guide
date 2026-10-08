#!/usr/bin/env -S npx tsx
/**
 * guide-pack — strumento a riga di comando per i Territory Pack.
 *
 *   guide-pack validate <cartella> [--pack <id>] [--strict] [--json]
 *   guide-pack photos <cartella-foto> [--territories <cartella-pack> --pack <id>]
 *
 * Carica tutti i pack sotto <cartella> (per risolvere le dipendenze),
 * li valida e stampa errori e avvisi. Esce con codice 1 se ci sono errori
 * (o avvisi, con --strict).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { argv, cwd, exit, stdout } from "node:process";
import { hasErrors, type PackIssue } from "./issues.ts";
import { loadPacks } from "./load.ts";
import { readPhotoLocation } from "./photo-location.ts";
import { summarizePack } from "./summary.ts";
import { validatePacks } from "./validate.ts";

function usage(): never {
  stdout.write(
    "Uso:\n  guide-pack validate <cartella> [--pack <id>] [--strict] [--json]\n" +
      "  guide-pack photos <cartella-foto> [--territories <cartella-pack> --pack <id>]\n",
  );
  exit(2);
}

/** Distanza approssimata in metri (sufficiente per trovare il luogo più vicino a una foto). */
function metersBetween(a: readonly [number, number], b: readonly [number, number]): number {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
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

function main(args: string[]): number {
  const [command, rootArg, ...rest] = args;
  if (command === "photos" && rootArg) return photos(rootArg, rest);
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
        `${errors ? "✗" : "✓"} ${s.id} ${s.version}${s.fictional ? " [fittizio]" : ""} · ${s.kind} · ` +
          `luoghi ${s.places} · nodi ${s.nodes} · fonti ${s.sources} · ` +
          `affermazioni ${s.assertions.verified}/${s.assertions.total} verificate · unità ${units} · percorsi ${s.routes}` +
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
