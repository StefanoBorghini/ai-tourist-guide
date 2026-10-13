/**
 * Compila i bundle delle destinazioni elencate in territories/static-bundles.json e li copia
 * in public/bundles/, con un indice. Gira prima di `next dev` e `next build`.
 *
 * Le destinazioni non elencate arrivano all'app solo dallo Studio (/pub/): i file del repository non conoscono
 * i contenuti a pagamento configurati nello Studio (lib/static-bundles.ts).
 * I territori fittizi (di test, in territories/_synthetic) restano fuori dall'app pubblicata: si includono
 * solo con GUIDE_INCLUDE_FICTIONAL=true (prove in locale).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundle } from "@guide/bundle";
import { loadPacks } from "@guide/territory-pack";
import { indexEntry, sortEntries, type BundleIndexEntry } from "../lib/bundle-index";
import { parseStaticList, staticBuildPlan } from "../lib/static-bundles";

const here = dirname(fileURLToPath(import.meta.url));
const TERRITORIES = resolve(here, "../../../territories");
const OUT = resolve(here, "../public/bundles");
const includeFictional = process.env.GUIDE_INCLUDE_FICTIONAL === "true";

const { packs, issues } = loadPacks(TERRITORIES);
if (issues.length > 0) {
  for (const i of issues) console.error(`ERRORE [${i.code}] ${i.packId}: ${i.message}`);
  process.exit(1);
}

const plan = staticBuildPlan(packs, parseStaticList(JSON.parse(readFileSync(join(TERRITORIES, "static-bundles.json"), "utf8"))), includeFictional);
if (plan.errors.length > 0) {
  for (const e of plan.errors) console.error(`ERRORE ${e}`);
  process.exit(1);
}
for (const s of plan.skipped) console.log(`· ${s.id}: niente bundle statico (${s.reason})`);

rmSync(OUT, { recursive: true, force: true });
const index: BundleIndexEntry[] = [];

for (const id of plan.build) {
  const pack = packs.get(id)!;
  for (const locale of pack.manifest.locales) {
    const bundle = buildBundle(packs, { destination: pack.manifest.id, locale, allowFictional: includeFictional,
      readAsset: (packDir, relativePath) => readFileSync(join(packDir, relativePath)),
    });
    // Difesa in profondità: un bundle statico non ha mai contenuti a pagamento esclusi.
    if (bundle.content.locked || bundle.premium.length > 0) {
      console.error(`ERRORE ${id}: un bundle statico non può avere contenuti a pagamento`);
      process.exit(1);
    }
    const dir = join(OUT, pack.manifest.id, `${locale}-full`);
    mkdirSync(dir, { recursive: true });
    for (const [path, data] of [...bundle.files, ...bundle.streamFiles]) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), data);
    }
    // Voce dell'indice, con la copertina per la pagina iniziale (immagine ed eventuale video).
    index.push(indexEntry(bundle.content, `/bundles/${pack.manifest.id}/${locale}-full/`));
    console.log(`✓ bundle ${pack.manifest.id} ${locale} (${(bundle.manifest.totalBytes / 1024).toFixed(1)} KB)${bundle.content.preview ? " [anteprima]" : ""}`);
  }
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "index.json"), JSON.stringify({ bundles: sortEntries(index) }, null, 2));
