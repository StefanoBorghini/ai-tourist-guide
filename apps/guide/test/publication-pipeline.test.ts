/**
 * Pipeline di pubblicazione (runPublication) con pubblicazioni immutabili (R2). Un client Supabase finto in memoria
 * imita il database (presa in carico, rinnovo, esito per identificativo, fotografie numerate dell'indice) e le
 * regole che il bucket impone (20261023000000): nessun file si sovrascrive, la cartella di una pubblicazione la
 * scrive solo chi la tiene in carico, si cancellano solo versioni morte. Le regole vere sono provate in SQL
 * (80_bundles_storage.sql); qui si prova che la pipeline, anche sospesa e ripresa, non tocca la versione in linea.
 * Il «processo sospeso» è simulato fermando A dentro una chiamata e facendo girare B per intero nel frattempo.
 */
import type { TerritoryPack } from "@guide/domain";
import { loadPacks, packToSnapshot } from "@guide/territory-pack";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/static-index", () => ({ staticDestinations: async () => new Set<string>() }));
const { runPublication } = await import("../lib/studio/server");
const { uploadRetrying } = await import("../lib/studio/publish");

const here = dirname(fileURLToPath(import.meta.url));
const TERRITORIES = resolve(here, "../../../territories");
const AREA = "it.test";
const VILLAGE = "it.test.borgo-di-prova";
const PREMIUM = { explore: "premium" as const, introPlaces: ["porta-del-borgo"], premiumRoutes: ["giro-breve"] };
const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const C = "cccccccc-0000-4000-8000-00000000000c";
const LEGACY_CONTENT = "content.0000000000000000.json";
const LOCALES = ["it", "en"];
const folder = (loc: string) => `${VILLAGE}/${loc}-full`;
const UUID = /^[^/]+\/[a-z]{2}-full\/([0-9a-f-]{36})\/(manifest\.json|content\.[0-9a-f]+\.json)$/;
/** Cartella di una pubblicazione nel bucket privato «premium». */
const PREMIUM_NS = /^[^/]+\/[a-z]{2}\/([0-9a-f-]{36})\/(explore|(?:route|place)-[a-z0-9-]+)\.[0-9a-f]{16,64}\.json$/;

function snapshots() {
  const packs = structuredClone(loadPacks(TERRITORIES).packs);
  const out = new Map<string, unknown>();
  for (const id of [AREA, VILLAGE]) {
    const pack = packs.get(id)!;
    pack.manifest.fictional = false;
    pack.sources = pack.sources.map((src) => ({ ...src, fictional: false }));
    pack.media = [];
    if (id === VILLAGE) pack.config.access = PREMIUM as TerritoryPack["config"]["access"];
    out.set(id, JSON.parse(JSON.stringify(packToSnapshot(pack, () => { throw new Error("nessun file"); }))));
  }
  return out;
}
const SNAPSHOTS = snapshots();

interface Hooks {
  /** Prima di rispondere al rinnovo n. `count` di una pubblicazione. */
  onRenew?: (publication: string, count: number) => Promise<void>;
  /** Prima di eseguire il caricamento di un file. */
  onUpload?: (path: string) => Promise<void>;
  failUpload?: (path: string) => boolean;
  /** Errore temporaneo dello Storage (sovraccarico) per i primi N tentativi di quel file. */
  busyUpload?: (path: string) => number;
  /** Caricamento che risponde «riuscito» ma il file non c'è (lo si scopre solo rileggendo il bucket). */
  loseUpload?: (path: string) => boolean;
  renewError?: boolean;
}

/** Database e bucket finti condivisi da più pipeline (A, B, …): ogni presa in carico riceve il prossimo id. */
function world(claims: string[], hooks: Hooks = {}) {
  const files = new Map<string, string>();
  const attempts = new Map<string, number>();
  // Versione in linea all'inizio: struttura precedente (manifest unico e index.json).
  for (const loc of LOCALES) {
    files.set(`${folder(loc)}/${LEGACY_CONTENT}`, "{}");
    files.set(`${folder(loc)}/manifest.json`, JSON.stringify({ content: LEGACY_CONTENT }));
  }
  files.set("index.json", JSON.stringify({ bundles: LOCALES.map((loc) => ({ destination: VILLAGE, name: "Borgo", locale: loc, fictional: false, manifest: `/pub/${folder(loc)}/manifest.json` })) }));
  // gen: ultimo numero d'indice emesso al momento dell'esito (report.indexGeneration).
  const pubs = new Map<string, { status: string; finished: number; entries: unknown[]; gen: number }>();
  let clock = 0;
  let seq = 0;
  const renews = new Map<string, number>();
  const log = { uploads: [] as string[], rejected: [] as string[], removed: [] as string[], finish: [] as Record<string, unknown>[] };
  // Una pubblicazione è nell'indice servito quando c'è un indice caricato con numero maggiore di quello registrato
  // al suo esito (studio_index_reflects).
  const reflected = (gen: number) => [...files.keys()].some((k) => /^index\/\d{20}\.json$/.test(k) && Number(k.slice(6, 26)) > gen);
  const dead = (id: string) => {
    const p = pubs.get(id);
    return !!p && (p.status === "failed" || (p.status === "published" && [...pubs.values()].some((q) => q.status === "published" && q.finished > p.finished && reflected(q.gen))));
  };
  const namespacedLive = () => [...pubs.values()].some((p) => p.status === "published" && reflected(p.gen) && /[0-9a-f-]{36}\/manifest/.test(JSON.stringify(p.entries)));
  // Un solo archivio per i due bucket: i file del bucket privato «premium» hanno il prefisso «premium::».
  const bucket = (name: string) => {
    const key = (p: string) => (name === "bundles" ? p : `${name}::${p}`);
    return {
      async list(path: string, opts: { limit: number; sortBy?: { order: string } } = { limit: 100 }) {
        const names = [...files.keys()].filter((k) => k.startsWith(`${key(path)}/`)).map((k) => k.slice(key(path).length + 1)).filter((n) => !n.includes("/")).sort();
        if (opts.sortBy?.order === "desc") names.reverse();
        return { data: names.slice(0, opts.limit).map((n) => ({ name: n })), error: null };
      },
      async upload(path: string, data: Uint8Array, opts: { upsert?: boolean }) {
        await hooks.onUpload?.(path);
        if (hooks.failUpload?.(path)) return { data: null, error: { message: "caricamento non riuscito" } };
        const busy = hooks.busyUpload?.(path) ?? 0;
        if (busy > 0 && (attempts.set(key(path), (attempts.get(key(path)) ?? 0) + 1), attempts.get(key(path))!) <= busy) {
          return { data: null, error: { message: "Too many connections issued to the database" } };
        }
        const deny = (why: string) => { log.rejected.push(path); return { data: null, error: { message: why } }; };
        if (name !== "bundles" && name !== "premium") return deny("bucket");
        if (opts.upsert) return deny("upsert non ammesso (nessuna policy di aggiornamento)");
        if (files.has(key(path))) return { data: null, error: { message: "The resource already exists" } };
        const ns = name === "premium" ? PREMIUM_NS.exec(path) : UUID.exec(path);
        const idx = /^index\/(\d{20})\.json$/.exec(path);
        const allowed = name === "premium"
          ? ns && pubs.get(ns[1])?.status === "building"
          : /^[^/]+\/[a-z]{2}-full\/media\//.test(path) || (ns && pubs.get(ns[1])?.status === "building") || (idx && Number(idx[1]) <= seq);
        if (!allowed) return deny("new row violates row-level security policy");
        if (!hooks.loseUpload?.(path)) files.set(key(path), new TextDecoder().decode(data));
        log.uploads.push(key(path));
        return { data: { path }, error: null };
      },
      async download(path: string) {
        const v = files.get(key(path));
        return v === undefined ? { data: null, error: { message: "Object not found" } } : { data: new Blob([v]), error: null };
      },
      async remove(paths: string[]) {
        for (const p of paths) {
          const ns = name === "premium" ? PREMIUM_NS.exec(p) : UUID.exec(p);
          const legacyContent = name === "bundles" && /^[^/]+\/[a-z]{2}-full\/content\.[0-9a-f]+\.json$/.test(p);
          // Come la policy di cancellazione: solo cartelle di pubblicazioni morte e, dopo la struttura nuova, i vecchi contenuti.
          if ((ns && dead(ns[1])) || (legacyContent && namespacedLive())) {
            files.delete(key(p));
            log.removed.push(key(p));
          }
        }
        return { data: [], error: null };
      },
    };
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    switch (fn) {
      case "studio_publication_claim": {
        const id = claims.shift()!;
        if ([...pubs.values()].some((p) => p.status === "building")) return { data: { ok: false, reason: "busy" }, error: null };
        pubs.set(id, { status: "building", finished: 0, entries: [], gen: 0 });
        return { data: { ok: true, publication: id }, error: null };
      }
      case "pack_snapshot":
        return { data: SNAPSHOTS.get(String(args.p_pack)) ?? null, error: null };
      case "studio_publication_renew": {
        const id = String(args.p_publication);
        const n = (renews.get(id) ?? 0) + 1;
        renews.set(id, n);
        await hooks.onRenew?.(id, n);
        if (hooks.renewError) return { data: null, error: { message: "rete interrotta" } };
        return { data: pubs.get(id)?.status === "building", error: null };
      }
      case "studio_publication_finish": {
        log.finish.push(args);
        const id = String(args.p_publication);
        const p = pubs.get(id);
        if (!p || p.status !== "building") return { data: null, error: { message: `la pubblicazione ${id} non è più in corso` } };
        p.status = args.p_ok ? "published" : "failed";
        p.finished = ++clock;
        p.gen = seq;
        if (args.p_ok) p.entries = (args.p_bundles as { entry: unknown }[]).map((b) => b.entry);
        return { data: { publication: id }, error: null };
      }
      case "studio_can_publish_any":
        return { data: true, error: null };
      case "studio_index_snapshot": {
        const n = ++seq;
        const latest = [...pubs.values()].filter((p) => p.status === "published").sort((a, b) => b.finished - a.finished)[0];
        return { data: { generation: n, name: `index/${String(n).padStart(20, "0")}.json`, index: { bundles: latest?.entries ?? [] } }, error: null };
      }
      case "studio_publication_dead_ids":
        return { data: [...pubs.keys()].filter(dead), error: null };
      default:
        throw new Error(`rpc inattesa: ${fn}`);
    }
  };
  const supabase = { rpc, storage: { from: bucket } } as unknown as Parameters<typeof runPublication>[0];
  /** Indice servito dall'app: la fotografia numerata più alta, altrimenti index.json (come proxy.ts). */
  const served = () => {
    const latest = [...files.keys()].filter((k) => /^index\/\d{20}\.json$/.test(k)).sort().pop() ?? "index.json";
    return JSON.parse(files.get(latest)!).bundles as { locale: string; manifest: string }[];
  };
  /** Ogni voce servita punta a un manifest presente, il cui contenuto è presente. */
  const servedIsComplete = () => served().every((e) => {
    const m = files.get(e.manifest.replace(/^\/pub\//, ""));
    return !!m && files.has(`${VILLAGE}/${e.locale}-full/${JSON.parse(m).content}`);
  });
  return { supabase, files, pubs, log, served, servedIsComplete };
}

describe("pipeline di pubblicazione immutabile (R2)", () => {
  it("prima pubblicazione: file nella cartella di A, verifica, in linea, indice numerato, via i contenuti vecchi", async () => {
    const w = world([A]);
    const r = await runPublication(w.supabase, VILLAGE);
    expect(r).toMatchObject({ ok: true, errors: [] });
    for (const loc of LOCALES) {
      expect(w.files.has(`${folder(loc)}/${A}/manifest.json`)).toBe(true);
      expect(w.files.has(`${folder(loc)}/${LEGACY_CONTENT}`)).toBe(false); // vecchio contenuto (gratuito) tolto
      expect(w.files.has(`${folder(loc)}/manifest.json`)).toBe(true); // il vecchio manifest non si tocca
    }
    expect(w.served().map((e) => e.manifest).sort()).toEqual(LOCALES.map((l) => `/pub/${folder(l)}/${A}/manifest.json`).sort());
    expect(w.servedIsComplete()).toBe(true);
    expect(w.log.rejected).toEqual([]);
    expect(w.log.uploads.some((p) => p.endsWith("/manifest.json") && !p.includes(A))).toBe(false);
  });

  it("A sospeso prima del manifest, B pubblica per intero, A riprende: A non scrive nulla, non cambia l'indice, non cancella nulla di B", async () => {
    let w!: ReturnType<typeof world>;
    let b: Awaited<ReturnType<typeof runPublication>> | undefined;
    w = world([A, B], {
      onRenew: async (id, n) => {
        // A si «sospende» al rinnovo prima del primo manifest (dopo i caricamenti delle due lingue): la presa
        // scade, B la sostituisce (A risulta fallita) e pubblica tutto.
        if (id === A && n === LOCALES.length + 1) {
          w.pubs.get(A)!.status = "failed";
          b = await runPublication(w.supabase, VILLAGE);
        }
      },
    });
    const a = await runPublication(w.supabase, VILLAGE);
    expect(b).toMatchObject({ ok: true });
    expect(a.ok).toBe(false);
    const servedBefore = JSON.stringify(w.served());
    expect(servedBefore).toContain(B);
    expect(servedBefore).not.toContain(A);
    expect(w.servedIsComplete()).toBe(true);
    // Nessun file di B rimosso, nessun manifest di A scritto.
    expect(w.log.removed.some((p) => p.includes(B))).toBe(false);
    expect([...w.files.keys()].some((k) => k.includes(`${A}/manifest.json`))).toBe(false);
  });

  it("A sospeso subito prima di caricare il manifest (rinnovo già superato): il bucket rifiuta la scrittura tardiva", async () => {
    let w!: ReturnType<typeof world>;
    w = world([A, B], {
      onUpload: async (path) => {
        if (path === `${folder("it")}/${A}/manifest.json` && w.pubs.get(A)!.status === "building") {
          w.pubs.get(A)!.status = "failed";
          await runPublication(w.supabase, VILLAGE);
        }
      },
    });
    const a = await runPublication(w.supabase, VILLAGE);
    expect(a.ok).toBe(false);
    expect(w.log.rejected).toContain(`${folder("it")}/${A}/manifest.json`);
    expect(JSON.stringify(w.served())).toContain(B);
    expect(w.servedIsComplete()).toBe(true);
  });

  it("A in linea ma sospeso prima di caricare la propria fotografia dell'indice: la fotografia tardiva di A non torna in vigore", async () => {
    let w!: ReturnType<typeof world>;
    let paused = false;
    w = world([A, B], {
      onUpload: async (path) => {
        // A ha già la sua fotografia (numero 1) e sta per caricarla: nel frattempo B pubblica (numero 2).
        if (!paused && /^index\//.test(path)) {
          paused = true;
          const b = await runPublication(w.supabase, VILLAGE);
          expect(b.ok).toBe(true);
        }
      },
    });
    const a = await runPublication(w.supabase, VILLAGE);
    expect(a.ok).toBe(true); // la fotografia di A è stata caricata, ma ha un numero più basso
    expect(JSON.stringify(w.served())).toContain(B);
    expect(JSON.stringify(w.served())).not.toContain(A);
    expect(w.servedIsComplete()).toBe(true);
    // La pulizia di A, che non è più in vigore, non ha cancellato nulla di B.
    expect(w.log.removed.some((p) => p.includes(B))).toBe(false);
    expect(a.warnings.join(" ")).toMatch(/non è ancora quello di questa pubblicazione/);
  });

  it("B in linea ma il suo indice non si carica: la versione servita (A) resta intera, anche contro cancellazioni dirette; C pulisce dopo il proprio indice", async () => {
    let failIndex = false;
    const w = world([A, B, C], { failUpload: (p) => failIndex && p.startsWith("index/") });
    expect((await runPublication(w.supabase, VILLAGE)).ok).toBe(true);
    failIndex = true;
    const b = await runPublication(w.supabase, VILLAGE);
    expect(b.ok).toBe(false);
    expect(b.errors.join(" ")).toMatch(/indice non aggiornato/);
    expect(JSON.stringify(w.served())).toContain(A);
    expect(w.servedIsComplete()).toBe(true);
    // A è sostituita nel database, ma l'indice servito la usa ancora: il bucket non la lascia cancellare.
    const filesOfA = [...w.files.keys()].filter((k) => k.includes(`/${A}/`));
    await w.supabase.storage.from("bundles").remove(filesOfA);
    expect(filesOfA.every((k) => w.files.has(k))).toBe(true);
    expect(w.servedIsComplete()).toBe(true);
    failIndex = false;
    expect((await runPublication(w.supabase, VILLAGE)).ok).toBe(true);
    expect(JSON.stringify(w.served())).toContain(C);
    expect(w.servedIsComplete()).toBe(true);
    expect([...w.files.keys()].some((k) => k.includes(`/${A}/`) || k.includes(`/${B}/`))).toBe(false);
  });

  it("errore intermedio o presa persa: nessun manifest, versione in linea integra, esito solo alla propria pubblicazione", async () => {
    for (const hooks of [{ failUpload: (p: string) => /\/content\./.test(p) }, { renewError: true }] satisfies Hooks[]) {
      const w = world([A], hooks);
      const before = JSON.stringify(w.served());
      const r = await runPublication(w.supabase, VILLAGE);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(w.served())).toBe(before);
      expect(w.servedIsComplete()).toBe(true);
      expect(w.log.removed).toEqual([]);
      expect([...w.files.keys()].some((k) => k.endsWith(`${A}/manifest.json`))).toBe(false);
      expect(w.log.finish).toEqual([expect.objectContaining({ p_ok: false, p_publication: A })]);
    }
  });

  it("Storage sovraccarico («Too many connections»): si riprova e la pubblicazione va in linea", async () => {
    const w = world([A], { busyUpload: (p) => (/\/content\.|\/place-|manifest\.json$/.test(p) ? 1 : 0) });
    const r = await runPublication(w.supabase, VILLAGE);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(w.served())).toContain(A);
    expect(w.servedIsComplete()).toBe(true);
  });

  it("Storage sempre sovraccarico: dopo i tentativi la pubblicazione si ferma e la versione in linea resta", async () => {
    const w = world([A], { busyUpload: (p) => (/\/content\./.test(p) ? 99 : 0) });
    const before = JSON.stringify(w.served());
    const r = await runPublication(w.supabase, VILLAGE);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/Too many connections/);
    expect(JSON.stringify(w.served())).toBe(before);
  }, 30000);

  it("un file risulta caricato ma nel bucket non c'è: la pubblicazione non va in linea", async () => {
    const w = world([A], { loseUpload: (p) => p === `${folder("en")}/${A}/manifest.json` });
    const before = JSON.stringify(w.served());
    const r = await runPublication(w.supabase, VILLAGE);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/file mancanti nel bucket/);
    expect(w.log.finish).toEqual([expect.objectContaining({ p_ok: false, p_publication: A })]);
    expect(JSON.stringify(w.served())).toBe(before);
    expect(w.servedIsComplete()).toBe(true);
  });

  it("ripubblicazione identica: nuova cartella, media condivisi non ricaricati, la versione precedente si toglie solo dopo", async () => {
    const w = world([A, B]);
    await runPublication(w.supabase, VILLAGE);
    const mediaBefore = w.log.uploads.filter((p) => p.includes("/media/")).length;
    const r = await runPublication(w.supabase, VILLAGE);
    expect(r.ok).toBe(true);
    expect(w.log.uploads.filter((p) => p.includes("/media/")).length).toBe(mediaBefore);
    expect(JSON.stringify(w.served())).toContain(B);
    expect(w.servedIsComplete()).toBe(true);
    // A (sostituita) è morta e non più nell'indice: tolta; B resta.
    expect([...w.files.keys()].some((k) => k.includes(`/${A}/`))).toBe(false);
    expect([...w.files.keys()].filter((k) => k.includes(`/${B}/`) && !k.startsWith("premium::")).length).toBe(LOCALES.length * 2);
    // Anche nel bucket privato: via le parti a pagamento di A, restano quelle di B (esplorazione e percorso per lingua,
    // più i singoli luoghi in vendita).
    const premiumB = [...w.files.keys()].filter((k) => k.startsWith("premium::") && k.includes(`/${B}/`));
    expect(premiumB.filter((k) => /\/(explore|route-[a-z0-9-]+)\./.test(k)).length).toBe(LOCALES.length * 2);
    expect(premiumB.some((k) => /\/place-[a-z0-9-]+\./.test(k))).toBe(true);
  });

  it("tre pubblicazioni di fila: l'indice servito va solo avanti e punta sempre a file completi", async () => {
    const w = world([A, B, C]);
    for (const id of [A, B, C]) {
      expect((await runPublication(w.supabase, VILLAGE)).ok).toBe(true);
      expect(JSON.stringify(w.served())).toContain(id);
      expect(w.servedIsComplete()).toBe(true);
    }
  });
});

describe("nuovi tentativi di caricamento (uploadRetrying)", () => {
  const busy = { error: { message: "Too many connections issued to the database" } };
  const run = (answers: { error: { message: string } | null }[]) => {
    let i = 0;
    const waits: number[] = [];
    const call = () => Promise.resolve(answers[Math.min(i++, answers.length - 1)]!);
    return { result: uploadRetrying(call, [1, 2, 3], async (ms) => { waits.push(ms); }), waits, calls: () => i };
  };

  it("riprova solo gli errori temporanei, con attese crescenti", async () => {
    const ok = run([busy, busy, { error: null }]);
    expect((await ok.result).error).toBeNull();
    expect(ok.waits).toEqual([1, 2]);
    const denied = run([{ error: { message: "new row violates row-level security policy" } }]);
    expect((await denied.result).error?.message).toMatch(/row-level/);
    expect(denied.calls()).toBe(1);
  });

  it("file già presente dopo un errore temporaneo: il tentativo precedente era arrivato; al primo tentativo invece è un errore", async () => {
    expect((await run([busy, { error: { message: "The resource already exists" } }]).result).error).toBeNull();
    expect((await run([{ error: { message: "The resource already exists" } }]).result).error).not.toBeNull();
  });

  it("dopo l'ultimo tentativo resta l'errore", async () => {
    const r = run([busy]);
    expect((await r.result).error?.message).toMatch(/Too many connections/);
    expect(r.calls()).toBe(4);
  });
});
