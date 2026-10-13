#!/usr/bin/env -S npx tsx
/**
 * guide-bundle — compila i bundle di runtime delle destinazioni.
 *
 *   guide-bundle build <cartella-pack> --destination <id> --locale <it|en> [--flavor full|lite]
 *                      [--out <cartella>] [--allow-fictional]
 *
 * Scrive <out>/<destinazione>/<lingua>-<variante>/manifest.json e il file dei contenuti.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argv, cwd, env, exit, stdout } from "node:process";
import type { Locale } from "@guide/domain";
import { loadPacks } from "@guide/territory-pack";
import { BundleBuildError, buildBundle } from "./build.ts";
import type { BundleFlavor } from "./format.ts";

function usage(): never {
  stdout.write(
    "Uso: guide-bundle build <cartella-pack> --destination <id> --locale <lingua> [--flavor full|lite] [--out <cartella>] [--allow-fictional]\n",
  );
  exit(2);
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(args: string[]): number {
  const [command, rootArg, ...rest] = args;
  const destination = option(rest, "--destination");
  const locale = option(rest, "--locale") as Locale | undefined;
  if (command !== "build" || !rootArg || !destination || !locale) usage();
  const flavor = (option(rest, "--flavor") ?? "full") as BundleFlavor;
  const base = env.INIT_CWD ?? cwd();
  const out = resolve(base, option(rest, "--out") ?? "dist/bundles");

  const loaded = loadPacks(resolve(base, rootArg));
  if (loaded.issues.length > 0) {
    for (const i of loaded.issues) stdout.write(`ERRORE [${i.code}] ${i.packId}: ${i.message}\n`);
    return 1;
  }
  try {
    const bundle = buildBundle(loaded.packs, {
      destination,
      locale,
      flavor,
      allowFictional: rest.includes("--allow-fictional"),
      readAsset: (packDir, rel) => new Uint8Array(readFileSync(join(packDir, rel))),
    });
    const dir = join(out, destination, `${locale}-${flavor}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const [path, data] of [...bundle.files, ...bundle.streamFiles]) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), data);
    }
    const c = bundle.content;
    stdout.write(
      `✓ ${destination} · ${locale}-${flavor} · ${(bundle.manifest.totalBytes / 1024).toFixed(1)} KB · ` +
        `luoghi ${c.places.length} · affermazioni ${c.assertions.length} · unità ${c.units.length} · percorsi ${c.routes.length} · immagini ${c.media.length}\n` +
        `  ${dir}\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof BundleBuildError) {
      stdout.write(`✗ ${err.message}\n`);
      for (const i of err.issues) stdout.write(`  ERRORE [${i.code}] ${i.packId} · ${[i.file, i.item].filter(Boolean).join(" › ")}: ${i.message}\n`);
      return 1;
    }
    throw err;
  }
}

exit(main(argv.slice(2)));
