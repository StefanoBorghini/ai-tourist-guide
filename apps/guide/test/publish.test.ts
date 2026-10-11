import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundle } from "@guide/bundle";
import { MEDIA_FILES_DIR, type Locale } from "@guide/domain";
import { loadPacks, mediaFileInfo, packToSnapshot } from "@guide/territory-pack";
import { describe, expect, it } from "vitest";
import { mergeIndexes, pubToStorageUrl, publishedOrigin, type BundleIndexEntry } from "../lib/bundle-index";
import { compilePublication, mediaPaths } from "../lib/studio/publish";

const here = dirname(fileURLToPath(import.meta.url));
const TERRITORIES = resolve(here, "../../../territories");
const json = (x: unknown) => JSON.parse(JSON.stringify(x)) as Record<string, unknown>;
const sha = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

/** Una destinazione come la crea lo Studio, con una foto di copertina. */
function destination(media: Record<string, unknown>[] = []) {
  return json({
    manifest: {
      schemaVersion: 1, id: "zz.borgo", kind: "destination", version: "0.1.0", name: { it: "Borgo", en: "Village" },
      defaultLocale: "it", locales: ["it", "en"], qualityTier: "silver", dependsOn: [], fictional: false, releaseStage: "research",
    },
    config: {},
    places: [{
      id: "piazza", placeKind: "poi", categories: ["piazza"], location: [9.9, 44.1], importance: 3, dwellMin: 10,
      labels: { it: { name: "Piazza" }, en: { name: "Square" } }, geofences: [{ kind: "arrival", radiusM: 40 }],
      coordinates: { status: "preliminary", method: "GPS" }, practical: [],
    }],
    sources: [{ id: "archivio", sourceKind: "archive_document", title: "Archivio", reliability: "A" }],
    assertions: [{
      id: "fontana", subject: "zz.borgo:piazza", predicate: "described_as", type: "fact", certainty: "established",
      status: "in_review", texts: { it: "La fontana è del 1890.", en: "The fountain dates from 1890." },
      evidence: [{ source: "zz.borgo:archivio", locator: "p. 4" }], authoredBy: "studio",
    }],
    units: [
      { id: "piazza-it", anchor: "zz.borgo:piazza", unitType: "opening", locale: "it", durationS: 20, text: "La fontana è del 1890.", assertions: ["fontana"] },
      { id: "piazza-en", anchor: "zz.borgo:piazza", unitType: "opening", locale: "en", durationS: 20, text: "The fountain dates from 1890.", assertions: ["fontana"] },
    ],
    routes: [], anchors: [], nodes: [], media,
  });
}
const photo = (extra: Record<string, unknown> = {}) => ({
  id: "piazza-foto", file: "piazza.jpg", subjects: ["zz.borgo:piazza"], alt: { it: "La piazza", en: "The square" },
  source: "own_photo", author: "Redazione", license: "own", cover: true, sha256: sha(JPEG), ...extra,
});

describe("compilazione di una pubblicazione", () => {
  it("una destinazione con foto diventa due bundle sotto /pub/, con copertina e file con l'impronta nel nome", () => {
    const snaps = new Map([["zz.borgo", destination([photo()])]]);
    expect(mediaPaths(snaps)).toEqual(["zz.borgo/piazza.jpg"]);
    const r = compilePublication("zz.borgo", snaps, new Map([["zz.borgo/piazza.jpg", JPEG]]));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.bundles.map((b) => b.locale)).toEqual(["it", "en"]);
    const it0 = r.bundles[0]!;
    expect(it0.folder).toBe("zz.borgo/it-full");
    expect(it0.entry.manifest).toBe("/pub/zz.borgo/it-full/manifest.json");
    expect(it0.entry.cover?.image).toMatch(/^\/pub\/zz\.borgo\/it-full\/media\/[0-9a-f]{16}\.jpg$/);
    expect([...it0.immutable.keys()].sort()).toEqual([it0.manifest.content, `media/${sha(JPEG).slice(0, 16)}.jpg`].sort());
    expect(JSON.parse(it0.manifestJson).kbHash).toBe(it0.manifest.kbHash);
  });

  it("un file diverso da quello registrato non si pubblica", () => {
    const r = compilePublication("zz.borgo", new Map([["zz.borgo", destination([photo({ sha256: "0".repeat(64) })])]]), new Map([["zz.borgo/piazza.jpg", JPEG]]));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/impronta/);
  });

  it("un file mancante della destinazione blocca; di una dipendenza è solo un avviso", () => {
    const missing = compilePublication("zz.borgo", new Map([["zz.borgo", destination([photo()])]]), new Map());
    expect(missing.ok).toBe(false);
    expect(missing.errors.join()).toMatch(/non presente nel bucket/);

    const region = json({
      manifest: { schemaVersion: 1, id: "zz", kind: "region", version: "0.1.0", name: { it: "Zona" }, defaultLocale: "it", locales: ["it"], qualityTier: "silver", dependsOn: [], fictional: false, releaseStage: "research" },
      config: {}, places: [], sources: [], assertions: [], units: [], routes: [], anchors: [],
      nodes: [{ id: "golfo", kind: "territory", labels: { it: { name: "Golfo" } } }],
      media: [{ id: "panorama", file: "panorama.jpg", subjects: ["zz:golfo"], alt: { it: "Panorama" }, source: "own_photo", author: "R", license: "own" }],
    });
    const dest = destination();
    (dest.manifest as Record<string, unknown>).dependsOn = ["zz"];
    const r = compilePublication("zz.borgo", new Map([["zz.borgo", dest], ["zz", region]]), new Map());
    expect(r.errors).toEqual([]);
    expect(r.warnings.join()).toMatch(/zz: foto panorama/);
  });

  it("un contenitore non si pubblica", () => {
    const region = destination();
    (region.manifest as Record<string, unknown>).kind = "region";
    expect(compilePublication("zz.borgo", new Map([["zz.borgo", region]]), new Map()).ok).toBe(false);
  });

  it("dal database si ottengono gli stessi bundle che dai file (ogni destinazione reale del repository)", () => {
    const { packs } = loadPacks(TERRITORIES);
    const real = [...packs.values()].filter((p) => p.manifest.kind === "destination" && !p.manifest.fictional);
    expect(real.length).toBeGreaterThan(0);
    for (const dest of real) {
      const scope = [dest.manifest.id, ...dest.manifest.dependsOn];
      const snaps = new Map(scope.map((id) => {
        const p = packs.get(id)!;
        return [id, json(packToSnapshot(p, (f) => mediaFileInfo(readFileSync(join(p.dir, MEDIA_FILES_DIR, f)))))];
      }));
      const files = new Map(scope.flatMap((id) => {
        const p = packs.get(id)!;
        return p.media.flatMap((m) => [m.file, ...(m.poster ? [m.poster] : [])])
          .map((f): [string, Uint8Array] => [`${id}/${f}`, readFileSync(join(p.dir, MEDIA_FILES_DIR, f))]);
      }));
      const r = compilePublication(dest.manifest.id, snaps, files);
      expect(r.errors).toEqual([]);
      for (const b of r.bundles) {
        const fromFiles = buildBundle(packs, { destination: dest.manifest.id, locale: b.locale as Locale, readAsset: (dir, rel) => readFileSync(join(dir, rel)) });
        expect(b.manifest.kbHash).toBe(fromFiles.manifest.kbHash);
        expect(b.manifest.content).toBe(fromFiles.manifest.content);
        expect(b.manifest.files).toEqual(fromFiles.manifest.files);
        expect([...b.stream.keys()]).toEqual([...fromFiles.streamFiles.keys()]);
      }
    }
  });
});

describe("indice dei bundle", () => {
  const entry = (destination: string, locale: string, manifest: string, name = destination): BundleIndexEntry => ({ destination, name, locale, fictional: false, manifest });

  it("una destinazione pubblicata dallo Studio sostituisce quella dei file, in tutte le lingue", () => {
    const merged = mergeIndexes(
      [entry("a", "it", "/bundles/a/it-full/manifest.json"), entry("a", "en", "/bundles/a/en-full/manifest.json"), entry("b", "it", "/bundles/b/it-full/manifest.json")],
      [entry("a", "it", "/pub/a/it-full/manifest.json")],
    );
    expect(merged.map((e) => e.manifest)).toEqual(["/pub/a/it-full/manifest.json", "/bundles/b/it-full/manifest.json"]);
  });

  it("senza indice pubblicato restano i file; voci che non puntano a /pub/ si ignorano", () => {
    const statics = [entry("b", "it", "/bundles/b/it-full/manifest.json")];
    expect(mergeIndexes(statics, null)).toEqual(statics);
    expect(mergeIndexes(statics, [entry("b", "it", "https://altro.example/manifest.json")])).toEqual(statics);
  });

  it("una voce pubblicata vale solo se punta alla cartella del suo territorio", () => {
    const statics = [entry("b", "it", "/bundles/b/it-full/manifest.json")];
    expect(mergeIndexes(statics, [entry("b", "it", "/pub/altro/it-full/manifest.json")])).toEqual(statics);
    expect(mergeIndexes(statics, [entry("b", "it", "/pub/b/../altro/it-full/manifest.json")])).toEqual(statics);
    expect(mergeIndexes(statics, [{ ...entry("b", "it", "/pub/b/it-full/manifest.json"), cover: { image: "/pub/altro/x.jpg", alt: "" } }])).toEqual(statics);
    expect(mergeIndexes(statics, [entry("b", "it", "/pub/b/it-full/manifest.json")]).map((e) => e.manifest)).toEqual(["/pub/b/it-full/manifest.json"]);
  });

  it("indirizzi del bucket pubblico", () => {
    expect(publishedOrigin({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co/" })).toBe("https://x.supabase.co");
    expect(publishedOrigin({})).toBeNull();
    expect(publishedOrigin({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co/rest" })).toBeNull();
    expect(pubToStorageUrl("/pub/a/it-full/manifest.json", "https://x.supabase.co")).toBe("https://x.supabase.co/storage/v1/object/public/bundles/a/it-full/manifest.json");
    expect(() => pubToStorageUrl("/bundles/a.json", "https://x.supabase.co")).toThrow();
  });
});
