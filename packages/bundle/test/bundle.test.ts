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
  allowedPremiumParts,
  mergePremium,
  type BundleContent,
  BundleBuildError,
  BundleIntegrityError,
  buildBundle,
  engineInputsFromBundle,
  libraryFromBundle,
  verifyBundle,
  type BuiltBundle,
  type Right,
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

/**
 * Panoramiche (racconti d'apertura) anche per chiesa, torre e belvedere, come in un territorio reale: senza, la
 * panoramica gratuita di un luogo principale sarebbe il suo primo racconto (decisione del 2026-10-22, testata a parte).
 */
const OPENED = ["belvedere", "chiesa-di-san-test", "torre-di-prova"];
const withOpenings = (src: Map<string, TerritoryPack>) => {
  const copy = structuredClone(src);
  for (const place of OPENED) {
    copy.get(D)!.units.push({
      id: `${place}-panoramica-it`, anchor: place, unitType: "opening", locale: "it", audience: "general", durationS: 15,
      text: "Panoramica di prova.", assertions: ["porta-funzione"], introduces: [], requires: [], hooks: [],
    });
  }
  return copy;
};
const OPENING_REFS = OPENED.map((p) => ref(`${p}-panoramica-it`));

describe("contenuti a pagamento (config.access)", () => {
  const withAccess = (access: NonNullable<TerritoryPack["config"]["access"]>) => {
    const copy = withOpenings(packs);
    copy.get(D)!.config.access = access;
    return buildBundle(copy, { destination: D, locale: "it", allowFictional: true });
  };
  // Frasi che esistono solo nei racconti e nei fatti a pagamento del borgo di prova (i nomi dei nodi,
  // come «Leggenda della sirena», restano pubblici: sono titoli, non contenuti).
  const PREMIUM_TEXTS = ["cantasse", "1150", "1220", "sue poesie", "presidiata"];

  it("senza configurazione tutto è pubblico e il bundle non cambia", () => {
    const free = buildBundle(withOpenings(packs), { destination: D, locale: "it", allowFictional: true });
    const explicit = withAccess({ explore: "free", introPlaces: [], premiumRoutes: [] });
    expect(free.premium).toEqual([]);
    expect(free.content.locked).toBeUndefined();
    expect(contentJson(explicit)).toBe(contentJson(free));
  });

  it("esplorazione a pagamento: pubbliche solo le panoramiche (aperture) dei luoghi principali e ciò che serve a capirle", () => {
    const b = withAccess({ explore: "premium", introPlaces: ["porta-del-borgo"], premiumRoutes: [] });
    expect(b.content.units.map((u) => u.ref)).toEqual(
      ["it.test:repubblica-introduzione-it", ...OPENING_REFS, ref("porta-apertura-it")].sort((a, b) => a.localeCompare(b)),
    );
    expect(b.content.assertions.map((a) => a.ref).sort()).toEqual(
      ["it.test:repubblica-controllo-costa", ref("porta-funzione"), ref("porta-larghezza")].sort(),
    );
    // Mappa, luoghi e percorsi gratuiti restano.
    expect(b.content.places).toHaveLength(5);
    expect(b.content.routes.map((r) => r.ref)).toEqual([ref("giro-breve")]);
    // Bloccati i luoghi a pagamento secondo lo Studio: tutti tranne i gratuiti, anche il carrugio, che non ha ancora
    // racconti (decisione del 2026-10-18), e la porta, luogo principale di cui resta gratuita la sola panoramica
    // (decisione del 2026-10-22).
    expect(b.content.locked).toEqual({
      explore: true, routes: [],
      places: [ref("belvedere"), ref("carrugio-centrale"), ref("chiesa-di-san-test"), ref("porta-del-borgo"), ref("torre-di-prova")],
    });
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

  it("la panoramica di un luogo principale è gratuita anche se non è introduttivo; quella di un sottoluogo no", () => {
    const b = withAccess({ explore: "premium", introPlaces: [], premiumRoutes: [] });
    expect(b.content.units.map((u) => u.ref)).toContain(ref("porta-apertura-it"));
    // Il carrugio è un sottoluogo della porta: la sua apertura, se fosse un sottoluogo, resterebbe a pagamento.
    const copy = withOpenings(packs);
    const units = copy.get(D)!.units;
    const porta = units.find((u) => u.id === "porta-apertura-it")!;
    porta.anchor = "carrugio-centrale";
    copy.get(D)!.config.access = { explore: "premium", introPlaces: [], premiumRoutes: [] };
    const sub = buildBundle(copy, { destination: D, locale: "it", allowFictional: true });
    expect(sub.content.units.some((u) => u.anchor === ref("carrugio-centrale"))).toBe(false);
    expect(sub.premium.find((p) => p.kind === "place" && p.ref === ref("porta-del-borgo"))!.units.map((u) => u.anchor)).toContain(ref("carrugio-centrale"));
  });

  it("senza racconto d'apertura la panoramica gratuita è il primo racconto del luogo principale (per tipo, poi riferimento)", () => {
    const copy = structuredClone(packs);
    copy.get(D)!.config.access = { explore: "premium", introPlaces: [], premiumRoutes: [] };
    const b = buildBundle(copy, { destination: D, locale: "it", allowFictional: true });
    const refs = new Set(b.content.units.map((u) => u.ref));
    // Chiesa (solo contesto) e torre (solo dettaglio): il loro unico racconto; belvedere: la curiosità prima della leggenda.
    expect(refs.has(ref("chiesa-datazione-it"))).toBe(true);
    expect(refs.has(ref("torre-dettaglio-it"))).toBe(true);
    expect(refs.has(ref("belvedere-ada-it"))).toBe(true);
    expect(refs.has(ref("belvedere-leggenda-it"))).toBe(false);
    // Il carrugio è un sottoluogo: nessuna panoramica sua; la leggenda resta solo a pagamento.
    expect(JSON.stringify(b.content.units)).not.toContain("cantasse");
    expect(b.premium.find((p) => p.kind === "place" && p.ref === ref("belvedere"))!.units.map((u) => u.ref)).toEqual([ref("belvedere-leggenda-it")]);
  });

  it("percorso premium: fuori dal bundle pubblico, presentato solo con nome e durata", () => {
    const b = withAccess({ explore: "free", introPlaces: [], premiumRoutes: ["giro-breve"] });
    expect(b.content.routes).toEqual([]);
    expect(b.content.locked).toEqual({ explore: false, routes: [{ ref: ref("giro-breve"), name: "Il borgo in 45 minuti", durationMin: 45 }] });
    expect(b.premium).toHaveLength(1);
    expect(b.premium[0]).toMatchObject({ kind: "route", ref: ref("giro-breve"), units: [] });
    expect(b.premium[0]!.routes[0]!.stops).toHaveLength(4);
    // Con l'esplorazione gratuita i racconti delle tappe restano pubblici.
    expect(b.content.units.length).toBe(build().content.units.length + OPENED.length);
  });

  it("percorso premium: la parte a pagamento ha l'itinerario e i racconti delle sue tappe (decisione 2026-10-18)", () => {
    const b = withAccess({ explore: "premium", introPlaces: ["porta-del-borgo"], premiumRoutes: ["giro-breve"] });
    const route = b.premium.find((p) => p.kind === "route")!;
    const explore = b.premium.find((p) => p.kind === "explore")!;
    const stops = new Set(route.routes[0]!.stops.map((st) => st.place));
    expect(route.routes.map((r) => r.ref)).toEqual([ref("giro-breve")]);
    // Racconti delle tappe, con i loro fatti e fonti: il percorso si ascolta senza l'esplorazione.
    expect(route.units.length).toBeGreaterThan(0);
    expect(route.units.filter((u) => stops.has(u.anchor)).length).toBeGreaterThan(0);
    for (const u of route.units) for (const a of u.assertions) expect(route.assertions.map((x) => x.ref)).toContain(a);
    // Nessun racconto già pubblico, e nessuno dei luoghi fuori dal percorso se non serve a capire le tappe.
    const publicRefs = new Set(b.content.units.map((u) => u.ref));
    for (const u of route.units) expect(publicRefs.has(u.ref)).toBe(false);
    const exploreRefs = new Set(explore.units.map((u) => u.ref));
    for (const u of route.units) expect(exploreRefs.has(u.ref)).toBe(true);
    // Ogni racconto del percorso è di una tappa o serve a capire una tappa (prerequisito introdotto altrove).
    const stopRequires = new Set(route.units.filter((u) => stops.has(u.anchor)).flatMap((u) => u.requires));
    for (const u of route.units) expect(stops.has(u.anchor) || u.introduces.some((c) => stopRequires.has(c))).toBe(true);
    expect(contentJson(b)).not.toContain("\"stops\"");
  });

  it("nessun identificativo di racconti, fatti o fonti a pagamento negli artefatti pubblici", () => {
    const b = withAccess({ explore: "premium", introPlaces: ["porta-del-borgo"], premiumRoutes: ["giro-breve"] });
    const publicFiles = [...b.files.values()].filter((f): f is string => typeof f === "string").join("\n");
    const explore = b.premium.find((p) => p.kind === "explore")!;
    const publicSources = new Set(b.content.sources.map((s) => s.ref));
    for (const u of explore.units) expect(publicFiles).not.toContain(`"${u.ref}"`);
    for (const a of explore.assertions) expect(publicFiles).not.toContain(`"${a.ref}"`);
    for (const s of explore.sources.filter((s) => !publicSources.has(s.ref))) expect(publicFiles).not.toContain(`"${s.ref}"`);
    // Riferimenti indiretti: ogni fatto citato da un racconto pubblico è pubblico, ogni fonte citata anche.
    const assertionRefs = new Set(b.content.assertions.map((a) => a.ref));
    for (const u of b.content.units) for (const a of u.assertions) expect(assertionRefs.has(a)).toBe(true);
    for (const a of b.content.assertions) for (const s of a.sources) expect(publicSources.has(s)).toBe(true);
  });

  it("i nodi citati solo dai racconti a pagamento non sono pubblici; quelli dei racconti gratuiti sì", () => {
    const b = withAccess({ explore: "premium", introPlaces: ["porta-del-borgo"], premiumRoutes: [] });
    const nodes = b.content.nodes.map((n) => n.ref);
    expect(nodes).not.toContain(ref("leggenda-della-sirena"));
    expect(nodes).not.toContain(ref("assedio-immaginario"));
    expect(nodes).not.toContain("it.test:ada-inventata");
    expect(nodes).toEqual(expect.arrayContaining(["it.test:difese-costiere", "it.test:repubblica-immaginaria"]));
    expect(contentJson(b)).not.toContain("sirena");
    // Senza esplorazione a pagamento i nodi restano tutti.
    expect(build().content.nodes.map((n) => n.ref)).toContain(ref("leggenda-della-sirena"));
  });

  it("le note di curatela restano nelle anteprime gratuite e spariscono con i contenuti a pagamento", () => {
    const copy = withOpenings(packs);
    const dest = copy.get(D)!;
    dest.manifest.releaseStage = "research";
    dest.places[0]!.curation = { storyStatus: "da verificare", notes: ["Appunto della redazione sul racconto riservato"] };
    const free = buildBundle(copy, { destination: D, locale: "it", allowFictional: true });
    expect(contentJson(free)).toContain("Appunto della redazione");
    for (const access of [
      { explore: "premium" as const, introPlaces: ["porta-del-borgo"], premiumRoutes: [] },
      { explore: "free" as const, introPlaces: [], premiumRoutes: ["giro-breve"] },
    ]) {
      dest.config.access = access;
      const paid = buildBundle(copy, { destination: D, locale: "it", allowFictional: true });
      expect(contentJson(paid)).not.toContain("Appunto della redazione");
      expect(paid.content.places.every((p) => p.curation === undefined)).toBe(true);
    }
  });

  it("il pianificatore narrativo funziona con il solo bundle pubblico", () => {
    const b = withAccess({ explore: "premium", introPlaces: ["porta-del-borgo"], premiumRoutes: [] });
    const library = libraryFromBundle(b.content);
    const at = (slug: string) => planStop({ library, memory: emptyMemory(), placeRef: ref(slug), locale: "it", timeBudgetS: 120 });
    expect(JSON.stringify(at("porta-del-borgo").items)).toContain(ref("porta-apertura-it"));
    // Della torre si racconta solo la panoramica gratuita, non il dettaglio a pagamento.
    expect(JSON.stringify(at("torre-di-prova").items)).not.toContain(ref("torre-dettaglio-it"));
  });
});

describe("diritti e parti a pagamento", () => {
  const parts = () => {
    const copy = structuredClone(packs);
    copy.get(D)!.config.access = { explore: "premium", introPlaces: ["porta-del-borgo"], premiumRoutes: ["giro-breve"] };
    return buildBundle(copy, { destination: D, locale: "it", allowFictional: true }).premium;
  };
  const kinds = (rights: Right[]) => allowedPremiumParts(D, parts(), rights).map((p) => `${p.kind}:${p.ref ?? ""}`);

  it("l'esplorazione completa non dà i percorsi premium", () => {
    expect(kinds([{ scope: "explore", destination: D }])).toEqual(["explore:"]);
  });

  it("un percorso dà solo quel percorso, con i racconti delle sue tappe ma non l'esplorazione completa", () => {
    expect(kinds([{ scope: "route", route: ref("giro-breve") }])).toEqual([`route:${ref("giro-breve")}`]);
    const got = allowedPremiumParts(D, parts(), [{ scope: "route", route: ref("giro-breve") }]);
    expect(got.flatMap((p) => p.units).length).toBeGreaterThan(0);
    expect(got.some((p) => p.kind === "explore")).toBe(false);
  });

  it("un luogo dà solo quel luogo, mai l'esplorazione né un percorso", () => {
    const place = parts().find((p) => p.kind === "place")!;
    expect(kinds([{ scope: "place", place: place.ref! }])).toEqual([`place:${place.ref}`]);
    expect(kinds([{ scope: "place", place: ref("luogo-inesistente") }])).toEqual([]);
  });

  it("senza diritti, o con diritti di un'altra destinazione o di un altro percorso, niente", () => {
    expect(kinds([])).toEqual([]);
    expect(kinds([{ scope: "explore", destination: "altro.territorio" }, { scope: "route", route: ref("altro-giro") }])).toEqual([]);
  });

  it("esplorazione e percorso insieme: entrambe le parti", () => {
    expect(kinds([{ scope: "explore", destination: D }, { scope: "route", route: ref("giro-breve") }])).toEqual(["explore:", `route:${ref("giro-breve")}`]);
  });
});

describe("unione dei contenuti acquistati (mergePremium)", () => {
  const ACCESS = { explore: "premium" as const, introPlaces: ["porta-del-borgo"], premiumRoutes: ["giro-breve"] };
  const built = () => {
    const copy = withOpenings(packs);
    copy.get(D)!.config.access = ACCESS;
    return buildBundle(copy, { destination: D, locale: "it", allowFictional: true });
  };
  const told = (c: BundleContent) => new Set(c.units.map((u) => u.anchor));

  it("percorso acquistato: il percorso si apre e i racconti delle sue tappe valgono anche nell'esplorazione libera", () => {
    const b = built();
    const route = b.premium.find((p) => p.kind === "route")!;
    const merged = mergePremium(b.content, [route]);
    expect(merged.routes.map((r) => r.ref)).toContain(ref("giro-breve"));
    // Le tappe del percorso comprato escono dai luoghi bloccati; gli altri restano.
    const stops = new Set(route.routes[0]!.stops.map((st) => st.place));
    expect(merged.locked).toEqual({ explore: true, routes: [], places: b.content.locked!.places!.filter((r) => !stops.has(r)) });
    expect(merged.locked!.places!.length).toBeGreaterThan(0);
    // I luoghi delle tappe ora hanno i loro racconti nel contenuto: l'esplorazione libera li racconta.
    for (const st of route.routes[0]!.stops) {
      if (route.units.some((u) => u.anchor === st.place)) expect(told(merged).has(st.place)).toBe(true);
    }
    // Nessun racconto dell'esplorazione completa che non sia del percorso.
    const extra = merged.units.filter((u) => !b.content.units.some((x) => x.ref === u.ref));
    expect(extra.map((u) => u.ref).sort()).toEqual(route.units.map((u) => u.ref).sort());
  });

  it("esplorazione acquistata dopo il percorso: nessun racconto duplicato, tutto sbloccato tranne i percorsi non comprati", () => {
    const b = built();
    const route = b.premium.find((p) => p.kind === "route")!;
    const explore = b.premium.find((p) => p.kind === "explore")!;
    const both = mergePremium(mergePremium(b.content, [route]), [explore]);
    const refs = both.units.map((u) => u.ref);
    expect(new Set(refs).size).toBe(refs.length);
    expect(both.locked).toBeUndefined();
    // Stesso risultato in qualunque ordine arrivino le parti.
    expect(mergePremium(b.content, [explore, route])).toEqual(both);
  });

  it("parti dei luoghi principali: una per principale, nessuna per i sottoluoghi; comprato il principale si sbloccano anche i sottoluoghi", () => {
    const b = built();
    const places = b.premium.filter((p) => p.kind === "place");
    expect(places.map((p) => p.ref)).toEqual([ref("belvedere"), ref("chiesa-di-san-test"), ref("porta-del-borgo"), ref("torre-di-prova")]);
    const porta = places.find((p) => p.ref === ref("porta-del-borgo"))!;
    const withPorta = mergePremium(b.content, [porta]);
    expect(withPorta.locked?.places).not.toContain(ref("porta-del-borgo"));
    expect(withPorta.locked?.places).not.toContain(ref("carrugio-centrale"));
    expect(withPorta.locked?.places).toContain(ref("belvedere"));
    const one = places.find((p) => p.ref === ref("belvedere"))!;
    // Prima dell'acquisto del belvedere c'è solo la sua panoramica, nessuno dei suoi racconti a pagamento.
    expect(one.units.some((u) => b.content.units.some((x) => x.ref === u.ref))).toBe(false);
    const merged = mergePremium(b.content, [one]);
    expect(told(merged).has(one.ref!)).toBe(true);
    expect(merged.locked?.explore).toBe(true);
    expect(merged.locked?.places).not.toContain(one.ref);
    expect(merged.locked?.places?.length).toBe(b.content.locked!.places!.length - 1);
    // Gli altri luoghi in vendita restano senza i loro racconti a pagamento (al più la panoramica pubblica).
    const mergedRefs = new Set(merged.units.map((u) => u.ref));
    for (const other of places.filter((p) => p !== one)) {
      for (const u of other.units.filter((x) => !one.units.some((y) => y.ref === x.ref))) expect(mergedRefs.has(u.ref)).toBe(false);
    }
    // Esplorazione comprata dopo il luogo: nessun racconto doppio.
    const explore = b.premium.find((p) => p.kind === "explore")!;
    const all = mergePremium(merged, [explore]);
    expect(new Set(all.units.map((u) => u.ref)).size).toBe(all.units.length);
    expect(all.locked).toEqual({ explore: false, routes: [{ ref: ref("giro-breve"), name: expect.any(String), durationMin: expect.any(Number) }] });
  });

  it("luogo gratuito: tutti i suoi racconti nel bundle pubblico, nessuna parte a pagamento, mai bloccato", () => {
    const copy = withOpenings(packs);
    copy.get(D)!.config.access = { ...ACCESS, freePlaces: ["belvedere"] };
    const b = buildBundle(copy, { destination: D, locale: "it", allowFictional: true });
    const belvedere = b.content.units.filter((u) => u.anchor === ref("belvedere"));
    expect(belvedere.length).toBeGreaterThan(1);
    expect(b.premium.some((p) => p.kind === "place" && p.ref === ref("belvedere"))).toBe(false);
    expect(b.content.locked?.places).not.toContain(ref("belvedere"));
    expect(b.premium.find((p) => p.kind === "explore")!.units.some((u) => u.anchor === ref("belvedere"))).toBe(false);
  });

  const withFree = (free: string[]) => {
    const copy = withOpenings(packs);
    copy.get(D)!.config.access = { ...ACCESS, freePlaces: free };
    return buildBundle(copy, { destination: D, locale: "it", allowFictional: true });
  };
  it("luogo principale gratuito con sottoluoghi a pagamento: la sua parte contiene solo i sottoluoghi e si compra", () => {
    const copy = withOpenings(packs);
    // La torre diventa sottoluogo del belvedere, che è gratuito.
    copy.get(D)!.places.find((p) => p.id === "torre-di-prova")!.partOf = "belvedere";
    copy.get(D)!.config.access = { ...ACCESS, freePlaces: ["belvedere"] };
    const b = buildBundle(copy, { destination: D, locale: "it", allowFictional: true });
    expect(b.content.locked?.places).not.toContain(ref("belvedere"));
    expect(b.content.locked?.places).toContain(ref("torre-di-prova"));
    const part = b.premium.find((p) => p.kind === "place" && p.ref === ref("belvedere"))!;
    expect(part.units.length).toBeGreaterThan(0);
    expect(part.units.every((u) => u.anchor !== ref("belvedere"))).toBe(true);
    expect(part.units.some((u) => u.anchor === ref("torre-di-prova"))).toBe(true);
    const merged = mergePremium(b.content, [part]);
    expect(merged.locked?.places).not.toContain(ref("torre-di-prova"));
    // Un principale gratuito senza sottoluoghi a pagamento non ha parte.
    const plain = withFree(["chiesa-di-san-test"]);
    expect(plain.premium.some((p) => p.kind === "place" && p.ref === ref("chiesa-di-san-test"))).toBe(false);
  });

  it("senza parti il contenuto resta identico", () => {
    const b = built();
    expect(mergePremium(b.content, [])).toBe(b.content);
  });
});
