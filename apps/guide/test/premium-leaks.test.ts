/**
 * Vie di fuga dei contenuti a pagamento oltre al bundle principale (revisione del branch commercio):
 * bundle compilati dai file del repository, ripiego sull'indice dei file quando quello pubblicato non si legge,
 * artefatti effettivamente pubblicati dallo Studio.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TerritoryPack } from "@guide/domain";
import { loadPacks, packToSnapshot } from "@guide/territory-pack";
import { describe, expect, it } from "vitest";
import { bundleBase, combineIndexes, currentIndexObject, fetchPublishedIndex, findEntry, loadIndexes, manifestPublication, mergeIndexes, type BundleIndexEntry } from "../lib/bundle-index";
import { verifyBundle, verifyPremiumPart, type PremiumPart } from "@guide/bundle/client";
import { parseStaticList, premiumBlockedByStatic, staticBuildPlan } from "../lib/static-bundles";
import { compilePublication, removeDeadVersions, type CleanupBucket } from "../lib/studio/publish";

const here = dirname(fileURLToPath(import.meta.url));
const TERRITORIES = resolve(here, "../../../territories");
const STATIC_LIST = parseStaticList(JSON.parse(readFileSync(resolve(TERRITORIES, "static-bundles.json"), "utf8")));
const real = () => structuredClone(loadPacks(TERRITORIES).packs);

const AREA = "it.test";
const VILLAGE = "it.test.borgo-di-prova";
const PREMIUM = { explore: "premium" as const, introPlaces: ["porta-del-borgo"], premiumRoutes: ["giro-breve"] };
// Frasi e identificativi che esistono solo nei racconti e nei fatti a pagamento del borgo di prova.
const PREMIUM_TEXTS = ["cantasse", "1150", "1220", "sue poesie", "presidiata", "Leggenda della sirena", "Ada Inventata"];
const PREMIUM_REFS = ["torre-dettaglio-it", "chiesa-datazione-it", "belvedere-leggenda-it", "sirena-racconto", "chiesa-datazione-a", "racconto-orale-fittizio"];

/** Il borgo di prova come lo vedrebbe lo Studio: istantanee del database, non fittizio, con l'accesso indicato. */
function studioSnapshots(access?: TerritoryPack["config"]["access"]) {
  const packs = real();
  const out = new Map<string, Record<string, unknown> | null>();
  for (const id of [AREA, VILLAGE]) {
    const pack = packs.get(id)!;
    // Solo per la prova: come un territorio reale (le fonti inventate non sono ammesse nei territori reali).
    pack.manifest.fictional = false;
    pack.sources = pack.sources.map((src) => ({ ...src, fictional: false }));
    pack.media = [];
    if (id === VILLAGE && access) pack.config.access = access;
    // Nessuna foto: il descrittore dei file non viene mai chiamato.
    out.set(id, JSON.parse(JSON.stringify(packToSnapshot(pack, () => { throw new Error("nessun file"); }))) as Record<string, unknown>);
  }
  return out;
}
const textOf = (data: Uint8Array | string) => (typeof data === "string" ? data : new TextDecoder().decode(data));

describe("bundle compilati dai file (P1)", () => {
  it("l'elenco reale non distribuisce più nulla dai file: Portovenere arriva solo dallo Studio (dal 2026-10-17)", () => {
    const plan = staticBuildPlan(real(), STATIC_LIST, false);
    expect(plan.errors).toEqual([]);
    expect(plan.build).toEqual([]);
  });

  it("una destinazione elencata si compila dai file", () => {
    expect(staticBuildPlan(real(), { destinations: ["it.liguria.sp.portovenere"] }, false).build).toEqual(["it.liguria.sp.portovenere"]);
  });

  it("una destinazione non elencata non ha bundle statici, anche senza contenuti a pagamento nei file", () => {
    const packs = real();
    const pv = packs.get("it.liguria.sp.portovenere")!;
    const plan = staticBuildPlan(packs, { destinations: [] }, false);
    expect(pv.config.access).toBeUndefined();
    expect(plan.build).toEqual([]);
    expect(plan.skipped.map((s) => s.id)).toContain("it.liguria.sp.portovenere");
  });

  it("rifiuta una destinazione elencata con contenuti a pagamento nei file, inesistente o non destinazione", () => {
    const packs = real();
    packs.get("it.liguria.sp.portovenere")!.config.access = { explore: "free", introPlaces: [], premiumRoutes: [] };
    expect(staticBuildPlan(packs, { destinations: ["it.liguria.sp.portovenere"] }, false).errors.join()).toMatch(/non può dichiarare l'accesso/);
    expect(staticBuildPlan(real(), { destinations: ["zz.inesistente"] }, false).errors.join()).toMatch(/non esiste/);
    expect(staticBuildPlan(real(), { destinations: ["it.liguria"] }, false).errors.join()).toMatch(/non è una destinazione/);
  });

  it("un territorio fittizio con contenuti a pagamento non va mai nei bundle statici, nemmeno nelle prove", () => {
    const packs = real();
    packs.get(VILLAGE)!.config.access = PREMIUM;
    const plan = staticBuildPlan(packs, STATIC_LIST, true);
    expect(plan.build).not.toContain(VILLAGE);
  });

  it("l'elenco deve essere esplicito", () => {
    expect(() => parseStaticList({})).toThrow();
    expect(() => parseStaticList({ destinations: [""] })).toThrow();
  });

  it("lo Studio non pubblica contenuti a pagamento per una destinazione con bundle statici, o se l'elenco non si legge", () => {
    const snaps = studioSnapshots(PREMIUM);
    const blocked = compilePublication(VILLAGE, snaps, new Map(), new Set([VILLAGE]));
    expect(blocked.ok).toBe(false);
    expect(blocked.errors.join()).toMatch(/distribuita anche dai file del repository/);
    expect(blocked.bundles).toEqual([]);
    const unknown = compilePublication(VILLAGE, snaps, new Map(), null);
    expect(unknown.ok).toBe(false);
    expect(unknown.errors.join()).toMatch(/non è leggibile/);
    expect(premiumBlockedByStatic(VILLAGE, new Set())).toBeNull();
  });

  it("senza contenuti a pagamento la pubblicazione di una destinazione statica resta permessa", () => {
    const r = compilePublication(VILLAGE, studioSnapshots(), new Map(), new Set([VILLAGE]));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("destinazione dello Studio a pagamento: nessun contenuto completo negli artefatti pubblicati né nei bundle statici", () => {
    const r = compilePublication(VILLAGE, studioSnapshots(PREMIUM), new Map(), new Set(["it.liguria.sp.portovenere"]));
    expect(r.errors).toEqual([]);
    // Tutto ciò che va nel bucket pubblico e nell'indice: file immutabili, manifest, voce dell'indice.
    const artifacts = r.bundles.flatMap((b) => [
      ...[...b.immutable.values(), ...b.stream.values()].map(textOf),
      b.manifestJson,
      JSON.stringify(b.entry),
    ]).join("\n");
    for (const t of PREMIUM_TEXTS) expect(artifacts).not.toContain(t);
    for (const ref of PREMIUM_REFS) expect(artifacts).not.toContain(`${VILLAGE}:${ref}"`);
    expect(artifacts).toContain("Sei davanti alla Porta del Borgo");
    // Nei bundle dai file la destinazione non c'è affatto (non è elencata).
    const packs = real();
    packs.get(VILLAGE)!.config.access = PREMIUM;
    expect(staticBuildPlan(packs, STATIC_LIST, false).build).not.toContain(VILLAGE);
  });
});

// ------------------------------------------------------------------ indice pubblicato (P2)

const entry = (destination: string, base: string): BundleIndexEntry => ({
  destination, name: destination, locale: "it", fictional: false, manifest: `${base}${destination}/it-full/manifest.json`,
});
const STATIC = [entry("it.liguria.sp.portovenere", "/bundles/")];
const PUBLISHED = [entry("zz.studio", "/pub/"), entry("it.liguria.sp.portovenere", "/pub/")];
const respond = (status: number, body: string) => async () => new Response(body, { status });

describe("indice pubblicato non disponibile (P2)", () => {
  it("riconosce indice assente, errore HTTP, JSON non valido, forma inattesa e rete assente", async () => {
    expect(await fetchPublishedIndex(respond(404, ""), "/pub/index.json")).toEqual({ ok: false, error: "indice pubblicato assente" });
    expect(await fetchPublishedIndex(respond(503, "x"), "/pub/index.json")).toEqual({ ok: false, error: "HTTP 503" });
    expect((await fetchPublishedIndex(respond(200, "{non json"), "/pub/index.json")).ok).toBe(false);
    expect((await fetchPublishedIndex(respond(200, '{"altro":[]}'), "/pub/index.json")).ok).toBe(false);
    const offline = await fetchPublishedIndex(async () => { throw new Error("timeout"); }, "/pub/index.json");
    expect(offline).toEqual({ ok: false, error: "rete: timeout" });
    expect(await fetchPublishedIndex(respond(200, JSON.stringify({ bundles: PUBLISHED })), "/pub/index.json")).toEqual({ ok: true, entries: PUBLISHED });
  });

  it("una destinazione solo dello Studio risulta temporaneamente non disponibile, mai sostituita da altro", () => {
    const down = combineIndexes(STATIC, { ok: false, error: "HTTP 503" });
    expect(findEntry(down, "zz.studio", "it")).toEqual({ unavailable: true });
    const up = combineIndexes(STATIC, { ok: true, entries: PUBLISHED });
    expect(findEntry(up, "zz.studio", "it")).toEqual({ entry: PUBLISHED[0] });
    expect(findEntry(up, "zz.altro", "it")).toEqual({ unknown: true });
  });

  it("per una destinazione con bundle statici (sempre gratuiti) il ripiego sui file resta", () => {
    const down = combineIndexes(STATIC, { ok: false, error: "rete: timeout" });
    expect(findEntry(down, "it.liguria.sp.portovenere", "it")).toEqual({ entry: STATIC[0] });
    const up = combineIndexes(STATIC, { ok: true, entries: PUBLISHED });
    expect(findEntry(up, "it.liguria.sp.portovenere", "it")).toEqual({ entry: PUBLISHED[1] });
  });

  it("l'app sa che l'indice pubblicato manca, e senza nessun indice dà errore", async () => {
    const routes = (map: Record<string, () => Promise<Response>>) => (url: string) => (map[url] ?? respond(404, ""))();
    const ok = respond(200, JSON.stringify({ bundles: STATIC }));
    const partial = await loadIndexes(routes({ "/bundles/index.json": ok, "/pub/index.json": respond(500, "") }), "/bundles/index.json", "/pub/index.json");
    expect(partial).toEqual({ entries: STATIC, publishedOk: false });
    const full = await loadIndexes(
      routes({ "/bundles/index.json": ok, "/pub/index.json": respond(200, JSON.stringify({ bundles: PUBLISHED })) }),
      "/bundles/index.json",
      "/pub/index.json",
    );
    expect(full.publishedOk).toBe(true);
    // Le voci pubblicate sostituiscono quelle dei file.
    expect(full.entries.map((e) => e.manifest).sort()).toEqual(PUBLISHED.map((e) => e.manifest).sort());
    const noSupabase = await loadIndexes(routes({ "/bundles/index.json": ok }), "/bundles/index.json", null);
    expect(noSupabase).toEqual({ entries: STATIC, publishedOk: true });
    await expect(loadIndexes(routes({}), "/bundles/index.json", "/pub/index.json")).rejects.toThrow(/assente/);
  });
});

// ------------------------------------------------------------------ versioni superate (P3)

describe("pubblicazioni immutabili (R2)", () => {
  const ID_A = "aaaaaaaa-0000-4000-8000-00000000000a";
  const ID_B = "bbbbbbbb-0000-4000-8000-00000000000b";
  const FOLDER = "it.test.borgo-di-prova/it-full";

  it("cartella dei file: quella della lingua, sia nella struttura precedente sia per pubblicazione", () => {
    expect(bundleBase("/pub/x.y/it-full/manifest.json")).toBe("/pub/x.y/it-full/");
    expect(bundleBase(`/pub/x.y/it-full/${ID_A}/manifest.json`)).toBe("/pub/x.y/it-full/");
    expect(bundleBase("/bundles/x.y/it-full/manifest.json")).toBe("/bundles/x.y/it-full/");
    expect(manifestPublication(`/pub/x.y/it-full/${ID_A}/manifest.json`)).toBe(ID_A);
    expect(manifestPublication("/pub/x.y/it-full/manifest.json")).toBeNull();
  });

  it("la compilazione mette manifest e contenuto nella cartella della pubblicazione, media e copertine restano condivisi", async () => {
    const legacy = compilePublication(VILLAGE, studioSnapshots(), new Map(), new Set());
    const ns = compilePublication(VILLAGE, studioSnapshots(), new Map(), new Set(), ID_A);
    expect(ns.ok).toBe(true);
    for (const [i, b] of ns.bundles.entries()) {
      const old = legacy.bundles[i];
      expect(b.manifestPath).toBe(`${ID_A}/manifest.json`);
      expect(b.manifest.content).toBe(`${ID_A}/${old.manifest.content}`);
      expect(b.entry.manifest).toBe(`/pub/${b.folder}/${ID_A}/manifest.json`);
      expect(b.entry.cover).toEqual(old.entry.cover); // copertina: media condivisi
      expect(b.immutable.has(b.manifest.content)).toBe(true);
      expect([...b.immutable.keys()].filter((k) => k.startsWith("media/"))).toEqual([...old.immutable.keys()].filter((k) => k.startsWith("media/")));
      // Il contenuto non cambia: stessa impronta, si verifica come prima e l'indice accetta la voce.
      expect(textOf(b.immutable.get(b.manifest.content)!)).toBe(textOf(old.immutable.get(old.manifest.content)!));
      const content = await verifyBundle(JSON.parse(b.manifestJson), textOf(b.immutable.get(b.manifest.content)!));
      expect(content.destination).toBe(VILLAGE);
      expect(mergeIndexes([], [b.entry])).toHaveLength(1);
    }
    expect(legacy.bundles.every((b) => b.manifestPath === "manifest.json")).toBe(true);
    expect(compilePublication(VILLAGE, studioSnapshots(), new Map(), new Set(), "../altro").ok).toBe(false);
  });

  it("indice in vigore: la fotografia numerata più alta; il vecchio index.json solo se non ce n'è nessuna; un errore resta un errore", async () => {
    const n = (k: number) => `${String(k).padStart(20, "0")}.json`;
    const list = (names: string[]) => async () => ({ data: names.map((name) => ({ name })), error: null });
    expect(await currentIndexObject(list([n(3), n(12), n(7), "altro.json"]))).toEqual({ ok: true, object: `index/${n(12)}` });
    expect(await currentIndexObject(list([]))).toEqual({ ok: true, object: "index.json" });
    expect(await currentIndexObject(async () => ({ data: null, error: { message: "rete" } }))).toMatchObject({ ok: false });
    expect(await currentIndexObject(async () => { throw new Error("rete"); })).toMatchObject({ ok: false });
  });

  /** Bucket in memoria per la pulizia. */
  function memoryBucket(names: string[]) {
    const store = new Set(names.map((n) => `${FOLDER}/${n}`));
    const removed: string[] = [];
    const bucket: CleanupBucket = {
      async list(path) {
        const out = [...store].filter((k) => k.startsWith(`${path}/`)).map((k) => k.slice(path.length + 1)).filter((n) => !n.includes("/"));
        return { data: out.map((name) => ({ name })), error: null };
      },
      async remove(paths) {
        for (const p of paths) { store.delete(p); removed.push(p); }
        return { error: null };
      },
    };
    return { bucket, removed, has: (n: string) => store.has(`${FOLDER}/${n}`) };
  }
  const entry = (manifest: string): BundleIndexEntry => ({ destination: VILLAGE, name: "Borgo", locale: "it", fictional: false, manifest });
  const FILES = ["manifest.json", "content.0000000000000000.json", "media/1111111111111111.jpg",
    `${ID_A}/manifest.json`, `${ID_A}/content.aaaaaaaaaaaaaaaa.json`, `${ID_B}/manifest.json`, `${ID_B}/content.bbbbbbbbbbbbbbbb.json`];

  it("pulizia di B in vigore: via le versioni morte e i contenuti della struttura precedente, restano B, i media e i manifest vecchi", async () => {
    const m = memoryBucket(FILES);
    const warnings = await removeDeadVersions(m.bucket, [FOLDER], [entry(`/pub/${FOLDER}/${ID_B}/manifest.json`)], [ID_A], ID_B);
    expect(warnings).toEqual([]);
    expect(m.removed.sort()).toEqual([`${FOLDER}/${ID_A}/content.aaaaaaaaaaaaaaaa.json`, `${FOLDER}/${ID_A}/manifest.json`, `${FOLDER}/content.0000000000000000.json`].sort());
    expect([`${ID_B}/manifest.json`, `${ID_B}/content.bbbbbbbbbbbbbbbb.json`, "media/1111111111111111.jpg", "manifest.json"].every(m.has)).toBe(true);
  });

  it("pulizia tardiva di A dopo che B è andata in linea: A non cancella nulla (né i file di B, né altro)", async () => {
    const m = memoryBucket(FILES);
    // A credeva di essere in linea, ma l'indice in vigore è ormai quello di B: nessuna cancellazione.
    const warnings = await removeDeadVersions(m.bucket, [FOLDER], [entry(`/pub/${FOLDER}/${ID_B}/manifest.json`)], [ID_A], ID_A);
    expect(m.removed).toEqual([]);
    expect(warnings.join(" ")).toMatch(/non è ancora quello di questa pubblicazione/);
  });

  it("indice in vigore in ritardo (punta ancora alla versione precedente): nessuna cancellazione, nemmeno di versioni morte", async () => {
    const m = memoryBucket(FILES);
    await removeDeadVersions(m.bucket, [FOLDER], [entry(`/pub/${FOLDER}/${ID_A}/manifest.json`)], [ID_A], ID_B);
    expect(m.removed).toEqual([]);
    const legacy = memoryBucket(FILES);
    await removeDeadVersions(legacy.bucket, [FOLDER], [entry(`/pub/${FOLDER}/manifest.json`)], [], ID_B);
    expect(legacy.removed).toEqual([]);
  });

  it("una pubblicazione in corso (non morta) non si cancella, e una versione in uso nemmeno se risultasse morta", async () => {
    const m = memoryBucket(FILES);
    await removeDeadVersions(m.bucket, [FOLDER], [entry(`/pub/${FOLDER}/${ID_B}/manifest.json`)], [ID_B], ID_B);
    expect(m.removed.some((p) => p.includes(ID_B))).toBe(false);
    expect(m.removed.some((p) => p.includes(ID_A))).toBe(false); // A non è nell'elenco delle morte: resta
  });

  it("la pubblicazione sa quali bundle hanno contenuti a pagamento (e solo quelli fanno pulizia)", () => {
    const paid = compilePublication(VILLAGE, studioSnapshots(PREMIUM), new Map(), new Set());
    expect(paid.bundles.every((b) => b.locked)).toBe(true);
    const free = compilePublication(VILLAGE, studioSnapshots(), new Map(), new Set());
    expect(free.bundles.some((b) => b.locked)).toBe(false);
  });
});

describe("parti a pagamento nel bucket privato (consegna, migrazione 20261027000000)", () => {
  // Stesso nome che le policy del bucket «premium» accettano (premium_object_name_ok).
  const NAME = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*\/[a-z]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(explore|(route|place)-[a-z0-9]+(-[a-z0-9]+)*)\.[0-9a-f]{16,64}\.json$/;
  const PUB = "0a0b0c0d-0000-4000-8000-000000000001";

  it("con l'esplorazione e un percorso a pagamento: un file per l'esplorazione, uno per il percorso e uno per ogni luogo in vendita", () => {
    const r = compilePublication(VILLAGE, studioSnapshots(PREMIUM), new Map(), new Set(), PUB);
    expect(r.errors).toEqual([]);
    for (const b of r.bundles) {
      const names = [...b.premium.keys()];
      for (const n of names) expect(n).toMatch(NAME);
      expect(names.filter((n) => n.includes(`/${b.locale}/${PUB}/explore.`))).toHaveLength(1);
      expect(names.filter((n) => n.includes(`/${b.locale}/${PUB}/route-giro-breve.`))).toHaveLength(1);
      // Singoli luoghi (migrazione 20261028000000): mai quello introduttivo, che è già gratuito.
      const places = names.filter((n) => n.includes(`/${b.locale}/${PUB}/place-`));
      if (b.locale === "it") expect(places.length).toBeGreaterThan(0);
      expect(places.some((n) => n.includes("/place-porta-del-borgo."))).toBe(false);
      expect(names).toHaveLength(2 + places.length);
    }
  });

  it("il file di un luogo contiene solo i racconti di quel luogo (con ciò che serve a capirli), mai l'esplorazione intera", () => {
    const r = compilePublication(VILLAGE, studioSnapshots(PREMIUM), new Map(), new Set(), PUB);
    const b = r.bundles.find((x) => x.locale === "it")!;
    const listed = b.manifest.premium ?? [];
    const explore = JSON.parse(textOf(b.premium.get(listed.find((f) => f.kind === "explore")!.path)!)) as PremiumPart;
    const exploreUnits = new Set(explore.units.map((u) => u.ref));
    for (const f of listed.filter((f) => f.kind === "place")) {
      const part = JSON.parse(textOf(b.premium.get(f.path)!)) as PremiumPart;
      expect(part.ref).toBe(f.ref);
      expect(part.routes).toEqual([]);
      // Un luogo ancora senza racconti ha il suo file vuoto (migrazione 20261030000000); altrimenti ci sono i suoi.
      if (part.units.length > 0) expect(part.units.some((u) => u.anchor === f.ref)).toBe(true);
      // Solo unità del luogo o suoi prerequisiti: tutte comprese nell'esplorazione, e meno di essa.
      for (const u of part.units) expect(exploreUnits.has(u.ref)).toBe(true);
      expect(part.units.length).toBeLessThan(explore.units.length);
    }
    // Il carrugio non ha racconti ma è a pagamento: il file c'è, vuoto.
    const carrugio = listed.find((f) => f.kind === "place" && f.ref?.endsWith(":carrugio-centrale"));
    expect(carrugio && (JSON.parse(textOf(b.premium.get(carrugio.path)!)) as PremiumPart).units).toEqual([]);
  });

  it("il manifest pubblico elenca solo nomi e impronte; i testi a pagamento stanno solo nei file privati", async () => {
    const r = compilePublication(VILLAGE, studioSnapshots(PREMIUM), new Map(), new Set(), PUB);
    const b = r.bundles.find((x) => x.locale === "it")!;
    const listed = b.manifest.premium ?? [];
    expect(listed.map((f) => f.path).sort()).toEqual([...b.premium.keys()].sort());
    const publicText = [b.manifestJson, ...[...b.immutable.values()].map(textOf)].join("\n");
    for (const t of PREMIUM_TEXTS) expect(publicText).not.toContain(t);
    const privateText = [...b.premium.values()].map(textOf).join("\n");
    expect(PREMIUM_TEXTS.some((t) => privateText.includes(t))).toBe(true);
    // Sul dispositivo: impronta e tipo verificati prima dell'unione; un file alterato si rifiuta.
    for (const f of listed) {
      const part = await verifyPremiumPart(f, textOf(b.premium.get(f.path)!));
      expect(part.kind).toBe(f.kind);
      await expect(verifyPremiumPart(f, textOf(b.premium.get(f.path)!) + " ")).rejects.toThrow();
    }
  });

  it("senza contenuti a pagamento, o senza pubblicazione, nessun file privato", () => {
    expect(compilePublication(VILLAGE, studioSnapshots(), new Map(), new Set(), PUB).bundles.every((b) => b.premium.size === 0 && !b.manifest.premium)).toBe(true);
    expect(compilePublication(VILLAGE, studioSnapshots(PREMIUM), new Map(), new Set()).bundles.every((b) => b.premium.size === 0)).toBe(true);
  });
});
