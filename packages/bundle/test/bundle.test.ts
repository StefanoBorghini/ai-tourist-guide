import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TerritoryPack } from "@guide/domain";
import { engineInputsFromPack, planTour } from "@guide/context-engine";
import { applyStopPlan, buildLibrary, emptyMemory, planStop, type TourMemory } from "@guide/narrative-planner";
import { loadPacks } from "@guide/territory-pack";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BundleBuildError,
  BundleIntegrityError,
  buildBundle,
  engineInputsFromBundle,
  libraryFromBundle,
  verifyBundle,
  type BuiltBundle,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_ROOT = resolve(here, "../../../territories/_synthetic");
const D = "it.test.borgo-di-prova";
const ref = (slug: string) => `${D}:${slug}`;

let packs: Map<string, TerritoryPack>;
const build = (overrides: Partial<Parameters<typeof buildBundle>[1]> = {}) =>
  buildBundle(packs, { destination: D, locale: "it", allowFictional: true, ...overrides });
const contentJson = (b: BuiltBundle) => b.files.get(b.manifest.content)!;

beforeAll(() => {
  const loaded = loadPacks(SYNTHETIC_ROOT);
  expect(loaded.issues).toEqual([]);
  packs = loaded.packs;
});

describe("compilazione", () => {
  it("include i contenuti della destinazione e delle dipendenze", () => {
    const { content } = build();
    expect(content.places.map((p) => p.ref)).toContain(ref("chiesa-di-san-test"));
    expect(content.nodes.map((n) => n.ref)).toContain("it.test:repubblica-immaginaria");
    expect(content.units.map((u) => u.ref)).toContain("it.test:repubblica-introduzione-it");
    expect(Object.keys(content.packVersions)).toEqual(["it.test", D]);
  });

  it("esclude le affermazioni non verificate", () => {
    const { content } = build();
    expect(content.assertions.map((a) => a.ref)).not.toContain(ref("torre-scalini"));
    expect(content.assertions.every((a) => a.text.length > 0)).toBe(true);
  });

  it("esclude i livelli di qualità non ammessi dal territorio", () => {
    const copy = structuredClone(packs);
    copy.get(D)!.config.narration.allowedQualityTiers = ["gold"];
    // Senza unità che citano affermazioni silver, il territorio resta valido ma il bundle non ha fatti.
    copy.get(D)!.units = [];
    copy.get("it.test")!.units = [];
    const { content } = buildBundle(copy, { destination: D, locale: "it", allowFictional: true });
    expect(content.assertions).toEqual([]);
    expect(content.units).toEqual([]);
  });

  it("contiene solo le unità della lingua richiesta", () => {
    const it_ = build({ locale: "it" }).content;
    const en = build({ locale: "en" }).content;
    expect(it_.units.every((u) => u.ref.endsWith("-it"))).toBe(true);
    expect(new Set(en.units.map((u) => u.ref))).toEqual(new Set(["it.test:repubblica-introduzione-en", ref("porta-apertura-en")]));
  });

  it("usa la lingua predefinita quando manca una traduzione, e lo dichiara", () => {
    const copy = structuredClone(packs);
    delete copy.get(D)!.assertions.find((a) => a.id === "porta-larghezza")!.texts.en;
    const { content } = buildBundle(copy, { destination: D, locale: "en", allowFictional: true });
    const a = content.assertions.find((x) => x.ref === ref("porta-larghezza"))!;
    expect(a.textLocale).toBe("it");
  });

  it("include solo le fonti citate", () => {
    const { content } = build();
    const cited = new Set(content.assertions.flatMap((a) => a.sources));
    expect(content.sources.every((s) => cited.has(s.ref))).toBe(true);
    expect(content.sources.length).toBeGreaterThan(0);
  });

  it("la variante leggera contiene solo aperture e unità introduttive", () => {
    const full = build({ flavor: "full" });
    const lite = build({ flavor: "lite" });
    expect(lite.content.units.length).toBeLessThan(full.content.units.length);
    expect(lite.content.units.every((u) => u.unitType === "opening" || u.introduces.length > 0)).toBe(true);
    expect(lite.manifest.totalBytes).toBeLessThan(full.manifest.totalBytes);
  });
});

describe("garanzie", () => {
  it("è deterministica: stessi pack, stessi byte, stesso hash", () => {
    const a = build();
    const b = build();
    expect(contentJson(a)).toBe(contentJson(b));
    expect(a.manifest).toEqual(b.manifest);
  });

  it("cambia il kbHash solo quando cambiano i fatti", () => {
    const base = build();
    const copy = structuredClone(packs);
    copy.get(D)!.units[0]!.text += " Fermati ad ascoltare il mare.";
    const onlyNarrative = buildBundle(copy, { destination: D, locale: "it", allowFictional: true });
    expect(onlyNarrative.manifest.kbHash).toBe(base.manifest.kbHash);
    expect(onlyNarrative.manifest.content).not.toBe(base.manifest.content);

    copy.get(D)!.assertions.find((a) => a.id === "porta-larghezza")!.texts.it = "Testo corretto dalla redazione.";
    expect(buildBundle(copy, { destination: D, locale: "it", allowFictional: true }).manifest.kbHash).not.toBe(base.manifest.kbHash);
  });

  it("rifiuta un territorio con errori di validazione", () => {
    const copy = structuredClone(packs);
    copy.get(D)!.assertions[0]!.evidence = [];
    expect(() => buildBundle(copy, { destination: D, locale: "it", allowFictional: true })).toThrow(BundleBuildError);
  });

  it("rifiuta i territori fittizi fuori dai test", () => {
    expect(() => buildBundle(packs, { destination: D, locale: "it" })).toThrow(/fittizio/);
  });

  it("rifiuta un pack che non è una destinazione e una lingua non prevista", () => {
    expect(() => build({ destination: "it.test" })).toThrow(/non una destinazione/);
    expect(() => build({ locale: "de" })).toThrow(/lingua/);
  });

  it("il manifest elenca i file con hash e dimensioni corretti", async () => {
    const b = build();
    const content = await verifyBundle(b.manifest, contentJson(b));
    expect(content.destination).toBe(D);
    expect(b.manifest.files[0]!.bytes).toBe(Buffer.byteLength(contentJson(b)));
  });

  it("la verifica rileva un contenuto alterato", async () => {
    const b = build();
    const tampered = contentJson(b).replace("Porta del Borgo", "Porta Falsa");
    await expect(verifyBundle(b.manifest, tampered)).rejects.toThrow(BundleIntegrityError);
  });
});

describe("l'app funziona con il solo bundle", () => {
  it("il pianificatore narrativo produce lo stesso racconto dal bundle e dai pack", async () => {
    const b = build();
    const fromBundle = libraryFromBundle(await verifyBundle(b.manifest, contentJson(b)));
    const fromPacks = buildLibrary(D, packs);
    const route = ["porta-del-borgo", "chiesa-di-san-test", "torre-di-prova", "belvedere"].map(ref);

    let mb: TourMemory = emptyMemory();
    let mp: TourMemory = emptyMemory();
    for (const [i, place] of route.entries()) {
      const req = { placeRef: place, locale: "it" as const, timeBudgetS: 90, nextPlaceRef: route[i + 1] ?? null };
      const pb = planStop({ ...req, library: fromBundle, memory: mb });
      const pp = planStop({ ...req, library: fromPacks, memory: mp });
      expect(pb).toEqual(pp);
      mb = applyStopPlan(mb, pb, fromBundle);
      mp = applyStopPlan(mp, pp, fromPacks);
    }
    expect(mb).toEqual(mp);
  });

  it("il motore di contesto pianifica lo stesso giro dal bundle e dai pack", () => {
    const b = build();
    const fromBundle = engineInputsFromBundle(b.content);
    const fromPack = engineInputsFromPack(packs.get(D)!);
    const now = Date.UTC(2026, 4, 15, 10, 0, 0);
    const start = { location: fromPack.anchors[0]!.location };
    const pb = planTour({ now, start, candidates: fromBundle.places, budgetMin: 40 });
    const pp = planTour({ now, start, candidates: fromPack.places, budgetMin: 40 });
    expect(pb.stops.map((s) => s.placeId)).toEqual(pp.stops.map((s) => ref(s.placeId)));
    expect(pb.endAt).toBe(pp.endAt);
  });
});
