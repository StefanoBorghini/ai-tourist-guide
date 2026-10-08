/**
 * Compila i bundle di tutte le destinazioni presenti in territories/ e li copia
 * in public/bundles/, con un indice. Gira prima di `next dev` e `next build`.
 *
 * I territori fittizi (di test) sono inclusi solo se GUIDE_INCLUDE_FICTIONAL non è "false":
 * finché non esiste un territorio reale, l'app mostra quello di prova, dichiarandolo.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundle } from "@guide/bundle";
import { loadPacks } from "@guide/territory-pack";

const here = dirname(fileURLToPath(import.meta.url));
const TERRITORIES = resolve(here, "../../../territories");
const OUT = resolve(here, "../public/bundles");
const includeFictional = process.env.GUIDE_INCLUDE_FICTIONAL !== "false";

const { packs, issues } = loadPacks(TERRITORIES);
if (issues.length > 0) {
  for (const i of issues) console.error(`ERRORE [${i.code}] ${i.packId}: ${i.message}`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
const index: { destination: string; name: string; locale: string; fictional: boolean; manifest: string }[] = [];

for (const pack of packs.values()) {
  if (pack.manifest.kind !== "destination") continue;
  if (pack.manifest.fictional && !includeFictional) continue;
  for (const locale of pack.manifest.locales) {
    const bundle = buildBundle(packs, { destination: pack.manifest.id, locale, allowFictional: includeFictional });
    const dir = join(OUT, pack.manifest.id, `${locale}-full`);
    mkdirSync(dir, { recursive: true });
    for (const [path, data] of bundle.files) writeFileSync(join(dir, path), data);
    index.push({
      destination: pack.manifest.id,
      name: bundle.content.name,
      locale,
      fictional: bundle.content.fictional,
      manifest: `/bundles/${pack.manifest.id}/${locale}-full/manifest.json`,
    });
    console.log(`✓ bundle ${pack.manifest.id} ${locale} (${(bundle.manifest.totalBytes / 1024).toFixed(1)} KB)`);
  }
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "index.json"), JSON.stringify({ bundles: index }, null, 2));
