#!/usr/bin/env node
/**
 * Regola di scalabilità: l'engine non contiene nulla di specifico per un territorio.
 *
 * Raccoglie gli id e i nomi dei pack di tipo "destination" sotto territories/
 * e verifica che non compaiano nel codice di apps/ e packages/.
 * Sono esclusi test, fixture e documentazione.
 *
 * Uso: node scripts/check-no-territory-code.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

const ROOT = new URL("..", import.meta.url).pathname;
const CODE_DIRS = ["apps", "packages"];
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|css)$/;
const SKIP_DIR = new Set(["node_modules", ".next", "dist", ".turbo", "test", "tests", "__tests__", "fixtures"]);
const SKIP_FILE = /(\.test\.|\.spec\.|package-lock\.json$)/;

function walk(dir, visit) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR.has(entry) || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, visit);
    else visit(full);
  }
}

// 1. Termini vietati: id del pack, ultimo segmento dell'id, nomi in ogni lingua.
const terms = new Map();
walk(join(ROOT, "territories"), (file) => {
  if (!file.endsWith("pack.yaml")) return;
  const manifest = parse(readFileSync(file, "utf8"));
  if (manifest?.kind !== "destination") return;
  const id = manifest.id;
  const add = (term) => {
    if (term && term.length >= 4) terms.set(term.toLowerCase(), id);
  };
  add(id);
  add(id.split(".").at(-1));
  for (const name of Object.values(manifest.name ?? {})) add(name);
});

// 2. Ricerca nel codice dell'engine.
const violations = [];
for (const dir of CODE_DIRS) {
  const base = join(ROOT, dir);
  if (!existsSync(base)) continue;
  walk(base, (file) => {
    if (!CODE_EXT.test(file) || SKIP_FILE.test(file)) return;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const lower = line.toLowerCase();
      for (const [term, packId] of terms) {
        if (lower.includes(term)) {
          violations.push(`${relative(ROOT, file)}:${i + 1} contiene "${term}" (territorio ${packId})`);
        }
      }
    });
  });
}

if (violations.length > 0) {
  console.error("✗ Codice specifico per territorio trovato nell'engine:");
  for (const v of violations) console.error(`  ${v}`);
  console.error("\nI dati di un territorio vanno nel suo Territory Pack, non nel codice.");
  process.exit(1);
}
console.log(`✓ Nessun codice specifico per territorio (${terms.size} termini controllati su ${CODE_DIRS.join(", ")}).`);
