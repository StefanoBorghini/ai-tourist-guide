#!/usr/bin/env -S npx tsx
/**
 * guide-pack — strumento a riga di comando per i Territory Pack.
 *
 *   guide-pack validate <cartella> [--pack <id>] [--strict] [--json]
 *
 * Carica tutti i pack sotto <cartella> (per risolvere le dipendenze),
 * li valida e stampa errori e avvisi. Esce con codice 1 se ci sono errori
 * (o avvisi, con --strict).
 */
import { resolve } from "node:path";
import { argv, cwd, exit, stdout } from "node:process";
import { hasErrors, type PackIssue } from "./issues.ts";
import { loadPacks } from "./load.ts";
import { summarizePack } from "./summary.ts";
import { validatePacks } from "./validate.ts";

function usage(): never {
  stdout.write("Uso: guide-pack validate <cartella> [--pack <id>] [--strict] [--json]\n");
  exit(2);
}

function main(args: string[]): number {
  const [command, rootArg, ...rest] = args;
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
