import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
const contentJson = (b: BuiltBundle) => b.files.get(b.manifest.content) as string;

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

describe("media", () => {
  const readAsset = (packDir: string, relativePath: string) => new Uint8Array(readFileSync(resolve(packDir, relativePath)));

  it("senza readAsset non include immagini", () => {
    const b = build();
    expect(b.content.media).toEqual([]);
    expect(b.manifest.files).toHaveLength(1);
  });

  it("include solo le immagini con licenza commerciale, indirizzate per contenuto", () => {
    const b = build({ readAsset });
    expect(b.content.media.map((m) => m.ref)).toEqual([ref("porta-del-borgo-foto")]);
    const [m] = b.content.media;
    expect(m!.path).toMatch(/^media\/[0-9a-f]{16}\.jpg$/);
    expect(m!.subjects).toEqual([ref("porta-del-borgo")]);
    expect(b.files.get(m!.path)).toBeInstanceOf(Uint8Array);
    expect(b.manifest.files.map((f) => f.path)).toContain(m!.path);
  });

  it("include le immagini non commerciali se il territorio le ammette", () => {
    const copy = structuredClone(packs);
    copy.get(D)!.config.media.allowNonCommercial = true;
    const b = buildBundle(copy, { destination: D, locale: "it", allowFictional: true, readAsset });
    const nc = b.content.media.find((m) => m.ref === ref("torre-foto-nc"))!;
    expect(nc.attribution).toContain("CC BY-NC");
    expect(nc.originalUrl).toBe("https://example.org/torre-fittizia");
  });

  it("i video restano fuori dal pacchetto offline, il loro poster no; la copertina è marcata", () => {
    const copy = structuredClone(packs);
    const pack = copy.get(D)!;
    // Copia del pack in una cartella temporanea, con un finto video accanto alle immagini.
    const dir = join(mkdtempSync(join(tmpdir(), "bundle-video-")), D);
    cpSync(pack.dir, dir, { recursive: true });
    const fakeVideo = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    writeFileSync(join(dir, "media/files/porta.mp4"), fakeVideo);
    pack.dir = dir;
    const photo = pack.media.find((m) => m.id === "porta-del-borgo-foto")!;
    photo.cover = true;
    pack.media.push({ ...photo, id: "porta-video", kind: "video", file: "porta.mp4", poster: photo.file, cover: true });
    const b = buildBundle(copy, { destination: D, locale: "it", allowFictional: true, readAsset });
    const video = b.content.media.find((m) => m.ref === ref("porta-video"))!;
    expect(video).toMatchObject({ kind: "video", cover: true });
    expect(video.path).toMatch(/^media\/[0-9a-f]{16}\.mp4$/);
    expect(b.streamFiles.get(video.path)).toEqual(fakeVideo);
    expect(b.files.has(video.path)).toBe(false);
    expect(b.manifest.files.map((f) => f.path)).not.toContain(video.path);
    expect(b.manifest.files.map((f) => f.path)).toContain(video.poster);
    expect(b.content.media.find((m) => m.ref === ref("porta-del-borgo-foto"))).toMatchObject({ cover: true });
    expect(b.content.media.find((m) => m.ref === ref("porta-del-borgo-foto"))!.kind).toBeUndefined();
  });

  it("è deterministico anche con le immagini", () => {
    expect(build({ readAsset }).manifest).toEqual(build({ readAsset }).manifest);
  });
});

describe("anteprima per i territori non ancora in produzione", () => {
  const withStage = (stage: "research" | "production") => {
    const copy = structuredClone(packs);
    const dest = copy.get(D)!;
    dest.manifest.releaseStage = stage;
    const a = dest.assertions.find((x) => x.status === "verified")!;
    a.status = "in_review";
    delete a.verifiedBy;
    // In produzione nessuna unità può citarla: le si tolgono le unità che la usano.
    if (stage === "production") dest.units = dest.units.filter((u) => !u.assertions.includes(a.id));
    return { copy, ref: ref(a.id) };
  };

  it("in produzione esclude le affermazioni in revisione e non è un'anteprima", () => {
    const { copy, ref: r } = withStage("production");
    const { content } = buildBundle(copy, { destination: D, locale: "it", allowFictional: true });
    expect(content.preview).toBe(false);
    expect(content.assertions.map((a) => a.ref)).not.toContain(r);
  });

  it("in ricerca le include, marcate, e il bundle si dichiara anteprima", () => {
    const { copy, ref: r } = withStage("research");
    const { content } = buildBundle(copy, { destination: D, locale: "it", allowFictional: true });
    expect(content.preview).toBe(true);
    expect(content.releaseStage).toBe("research");
    expect(content.assertions.find((a) => a.ref === r)?.inReview).toBe(true);
    expect(content.assertions.find((a) => a.ref === r)?.sourceUnconfirmed).toBeUndefined();
    // Le bozze restano fuori anche in anteprima.
    const drafts = copy.get(D)!.assertions.filter((a) => a.status === "draft").map((a) => ref(a.id));
    expect(content.assertions.some((a) => drafts.includes(a.ref))).toBe(false);
  });

  it("marca le affermazioni con fonte solo dedotta", () => {
    const { copy, ref: r } = withStage("research");
    const a = copy.get(D)!.assertions.find((x) => ref(x.id) === r)!;
    a.evidence = a.evidence.map((e) => ({ ...e, attribution: "inferred" as const }));
    const { content } = buildBundle(copy, { destination: D, locale: "it", allowFictional: true });
    expect(content.assertions.find((x) => x.ref === r)?.sourceUnconfirmed).toBe(true);
  });

  it("porta nei luoghi lo stato delle coordinate", () => {
    expect(build().content.places.every((p) => p.coordinateStatus === "field_verified")).toBe(true);
  });
});

describe("contenuti a pagamento (config.access)", () => {
  const withAccess = (access: NonNullable<TerritoryPack["config"]["access"]>) => {
    const copy = structuredClone(packs);
    copy.get(D)!.config.access = access;
    return buildBundle(copy, { destination: D, locale: "it", allowFictional: true });
  };
  // Frasi che esistono solo nei racconti e nei fatti a pagamento del borgo di prova (i nomi dei nodi,
  // come «Leggenda della sirena», restano pubblici: sono titoli, non contenuti).
  const PREMIUM_TEXTS = ["cantasse", "1150", "1220", "sue poesie", "presidiata"];

  it("senza configurazione tutto è pubblico e il bundle non cambia", () => {
    const free = build();
    const explicit = withAccess({ explore: "free", introPlaces: [], premiumRoutes: [] });
    expect(free.premium).toEqual([]);
    expect(free.content.locked).toBeUndefined();
    expect(contentJson(explicit)).toBe(contentJson(free));
  });

  it("esplorazione a pagamento: pubbliche solo le aperture dei luoghi introduttivi e ciò che serve a capirle", () => {
    const b = withAccess({ explore: "premium", introPlaces: ["porta-del-borgo"], premiumRoutes: [] });
    expect(b.content.units.map((u) => u.ref)).toEqual(["it.test:repubblica-introduzione-it", ref("porta-apertura-it")]);
    expect(b.content.assertions.map((a) => a.ref).sort()).toEqual(
      ["it.test:repubblica-controllo-costa", ref("porta-funzione"), ref("porta-larghezza")].sort(),
    );
    // Mappa, luoghi e percorsi gratuiti restano.
    expect(b.content.places).toHaveLength(5);
    expect(b.content.routes.map((r) => r.ref)).toEqual([ref("giro-breve")]);
    expect(b.content.locked).toEqual({ explore: true, routes: [] });
    // Nessun testo a pagamento in nessun file pubblico.
    const files = [...b.files.values()].filter((f): f is string => typeof f === "string").join("\n");
    for (const text of PREMIUM_TEXTS) expect(files).not.toContain(text);
    const premiumJson = JSON.stringify(b.premium);
    for (const text of PREMIUM_TEXTS) expect(premiumJson).toContain(text);
    // …ma nella parte a pagamento sì, con i loro fatti e le loro fonti.
    const [explore] = b.premium;
    expect(explore!.kind).toBe("explore");
    expect(explore!.units.map((u) => u.ref)).toEqual([
      ref("belvedere-ada-it"), ref("belvedere-leggenda-it"), ref("chiesa-datazione-it"), ref("torre-dettaglio-it"),
    ]);
    expect(explore!.assertions.map((a) => a.ref)).toContain(ref("sirena-racconto"));
    expect(explore!.sources.map((s) => s.ref)).toContain(ref("racconto-orale-fittizio"));
  });

  it("percorso premium: fuori dal bundle pubblico, presentato solo con nome e durata", () => {
    const b = withAccess({ explore: "free", introPlaces: [], premiumRoutes: ["giro-breve"] });
    expect(b.content.routes).toEqual([]);
    expect(b.content.locked).toEqual({ explore: false, routes: [{ ref: ref("giro-breve"), name: "Il borgo in 45 minuti", durationMin: 45 }] });
    expect(b.premium).toHaveLength(1);
    expect(b.premium[0]).toMatchObject({ kind: "route", ref: ref("giro-breve"), units: [] });
    expect(b.premium[0]!.routes[0]!.stops).toHaveLength(4);
    // Con l'esplorazione gratuita i racconti delle tappe restano pubblici.
    expect(b.content.units.length).toBe(build().content.units.length);
  });

  it("percorso premium con esplorazione a pagamento: porta con sé i racconti delle sue tappe", () => {
    const b = withAccess({ explore: "premium", introPlaces: ["porta-del-borgo"], premiumRoutes: ["giro-breve"] });
    const route = b.premium.find((p) => p.kind === "route")!;
    expect(route.units.map((u) => u.ref)).toEqual([
      ref("belvedere-ada-it"), ref("belvedere-leggenda-it"), ref("chiesa-datazione-it"), ref("torre-dettaglio-it"),
    ]);
    expect(contentJson(b)).not.toContain("\"stops\"");
  });

  it("il pianificatore narrativo funziona con il solo bundle pubblico", () => {
    const b = withAccess({ explore: "premium", introPlaces: ["porta-del-borgo"], premiumRoutes: [] });
    const library = libraryFromBundle(b.content);
    const at = (slug: string) => planStop({ library, memory: emptyMemory(), placeRef: ref(slug), locale: "it", timeBudgetS: 120 });
    expect(JSON.stringify(at("porta-del-borgo").items)).toContain(ref("porta-apertura-it"));
    expect(at("torre-di-prova").items).toEqual([]);
  });
});
