/**
 * Studio, lato server: client Supabase con la sessione dell'utente (cookie) e controllo dello staff.
 *
 * Ogni pagina e ogni azione passano da requireStaff(): l'utente è verificato dal server di
 * autenticazione (getUser, non il solo cookie) e ogni dato arriva dalle funzioni studio_* del
 * database, che applicano RLS e regole redazionali con l'identità dell'utente. Nessuna chiave di
 * servizio: lo Studio non scavalca mai le policy.
 */
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { BUNDLES_BUCKET, currentIndexObject, INDEX_DIR, type BundleIndexEntry } from "../bundle-index";
import { premiumBlockedByStatic } from "../static-bundles";
import { staticDestinations } from "../static-index";
import { MEDIA_BUCKET, readStudioConfig, type StudioConfig } from "./shared";

export function studioConfig(): StudioConfig | null {
  return readStudioConfig({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
}

export async function studioClient(config: StudioConfig): Promise<SupabaseClient> {
  const store = await cookies();
  return createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Nei componenti server i cookie sono in sola lettura: li aggiorna proxy.ts.
        }
      },
    },
  });
}

export interface StudioMe {
  userId: string;
  admin: boolean;
  roles: { role: string; pack: string | null }[];
}

export interface StudioSession {
  supabase: SupabaseClient;
  user: User;
  me: StudioMe;
  config: StudioConfig;
}

/** Utente autenticato con almeno un ruolo nello Studio; altrimenti accesso o pagina di diniego. */
export async function requireStaff(): Promise<StudioSession> {
  const config = studioConfig();
  if (!config) redirect("/studio/login");
  const supabase = await studioClient(config);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) redirect("/studio/login");
  const me = await supabase.rpc("studio_me");
  if (me.error) redirect("/studio/login?errore=sessione");
  const profile = me.data as StudioMe;
  if (!profile.admin && profile.roles.length === 0) redirect("/studio/accesso-negato");
  return { supabase, user: data.user, me: profile, config };
}

/** Chiamata a una funzione studio_*: dati o messaggio d'errore già comprensibile. */
export async function rpc<T>(supabase: SupabaseClient, fn: string, args?: Record<string, unknown>): Promise<{ data: T | null; error: { message: string; code?: string } | null }> {
  const { data, error } = await supabase.rpc(fn, args);
  return { data: (data ?? null) as T | null, error: error ? { message: error.message, code: error.code } : null };
}

/**
 * Indirizzi temporanei (10 minuti) dei file nel bucket privato «media», con i permessi dell'utente.
 * Un file non ancora caricato (per esempio un media importato da un pack) resta senza indirizzo.
 */
export async function signedMediaUrls(supabase: SupabaseClient, paths: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const { data } = await supabase.storage.from("media").createSignedUrls(unique, 600);
  return new Map((data ?? []).flatMap((d) => (d.signedUrl && d.path && !d.error ? [[d.path, d.signedUrl] as const] : [])));
}

/**
 * Controllo di pubblicazione: istantanee del territorio e dei territori da cui dipende (lette con i
 * permessi dell'utente), file presenti nel bucket, poi validatore e prova di compilazione.
 */
/** Istantanee del territorio e, ricorsivamente, dei territori da cui dipende (null se non leggibili). */
async function loadSnapshots(supabase: SupabaseClient, pack: string) {
  const snapshots = new Map<string, Record<string, unknown> | null>();
  const load = async (id: string) => {
    if (snapshots.has(id)) return;
    const { data } = await supabase.rpc("pack_snapshot", { p_pack: id });
    snapshots.set(id, (data ?? null) as Record<string, unknown> | null);
    const deps = ((data as { manifest?: { dependsOn?: string[] } } | null)?.manifest?.dependsOn ?? []);
    for (const d of deps) await load(d);
  };
  await load(pack);
  return snapshots;
}

export async function checkReadiness(supabase: SupabaseClient, pack: string) {
  const { assessReadiness } = await import("./readiness");
  const snapshots = await loadSnapshots(supabase, pack);
  const target = snapshots.get(pack) as { media?: { file: string; poster?: string }[] } | null;
  const paths = (target?.media ?? []).flatMap((m) => [m.file, ...(m.poster ? [m.poster] : [])]).map((f) => `${pack}/${f}`);
  const stored = new Set((await signedMediaUrls(supabase, paths)).keys());
  const result = assessReadiness(pack, snapshots, stored);
  // Contenuti a pagamento su una destinazione con bundle statici: lo dice subito (lo ricontrolla la pubblicazione).
  const access = (snapshots.get(pack) as { config?: { access?: { explore?: string; premiumRoutes?: string[] } } } | null)?.config?.access;
  const blocked = access && (access.explore === "premium" || (access.premiumRoutes ?? []).length > 0)
    ? premiumBlockedByStatic(pack, await staticDestinations())
    : null;
  if (!blocked) return result;
  return { ...result, ok: false, errors: [...result.errors, { level: "error" as const, code: "STATIC_PREMIUM", pack, message: blocked }] };
}

// ---------------------------------------------------------------- pubblicazione

const CONTENT_TYPES: Record<string, string> = {
  json: "application/json", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg",
};
const contentType = (path: string) => CONTENT_TYPES[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
/** File con l'impronta nel nome: un anno in cache. Manifest e indice: sempre ricontrollati. */
const IMMUTABLE = "31536000";
const MUTABLE = "0";

/** Esegue i compiti con al massimo `limit` richieste insieme. */
async function pool<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await task(item);
  }));
}

export interface PublicationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  bundles: { locale: string; totalBytes: number; places: number; units: number }[];
}

/**
 * Indice pubblico ricalcolato dal database e caricato come nuova fotografia numerata (index/<numero>.json, mai
 * sovrascritta): l'app legge quella col numero più alto (proxy.ts). Numero e contenuto li dà
 * studio_index_snapshot in modo coerente: una fotografia caricata in ritardo da un processo sospeso ha un numero
 * più basso di quelle prese dopo, quindi non torna mai in vigore.
 */
export async function refreshPublicIndex(supabase: SupabaseClient): Promise<string | null> {
  // L'indice di tutti lo riscrive solo lo staff della piattaforma (20261021000000_cms_hardening.sql).
  const allowed = await supabase.rpc("studio_can_publish_any");
  if (allowed.data !== true) return "l'indice dell'app lo aggiorna lo staff della piattaforma";
  const { data, error } = await supabase.rpc("studio_index_snapshot");
  if (error) return error.message;
  const snap = data as { name?: string; index?: unknown } | null;
  if (!snap?.name || !snap.index) return "fotografia dell'indice non valida";
  const up = await supabase.storage.from(BUNDLES_BUCKET).upload(snap.name, new TextEncoder().encode(JSON.stringify(snap.index)), {
    contentType: "application/json", upsert: false, cacheControl: MUTABLE,
  });
  return up.error ? up.error.message : null;
}

/** Indice in vigore, letto dal bucket come lo legge l'app (null se non si legge). */
async function visibleIndex(supabase: SupabaseClient): Promise<BundleIndexEntry[] | null> {
  const bucket = supabase.storage.from(BUNDLES_BUCKET);
  const found = await currentIndexObject(() => bucket.list(INDEX_DIR, { limit: 1, sortBy: { column: "name", order: "desc" } }));
  if (!found.ok) return null;
  const { data } = await bucket.download(found.object);
  if (!data) return null;
  try {
    const bundles = (JSON.parse(await data.text()) as { bundles?: unknown }).bundles;
    return Array.isArray(bundles) ? (bundles as BundleIndexEntry[]) : null;
  } catch {
    return null;
  }
}

/**
 * Pipeline di pubblicazione, con la sessione di chi pubblica (le policy decidono cosa può scrivere):
 * presa in carico (una pubblicazione alla volta per territorio) → istantanee → file media dal bucket «media» →
 * compilazione nella cartella della pubblicazione → file nel bucket «bundles» (prima quelli con l'impronta, poi i
 * manifest; nessuno si sovrascrive) → verifica che ci siano tutti → esito nel database → indice numerato → pulizia
 * delle versioni morte. Prima di ogni manifest la presa in carico si rinnova; comunque il bucket accetta i file di
 * una pubblicazione solo finché è in corso (R2, 20261023000000_bundles_storage.sql).
 * Se qualcosa va storto la pubblicazione risulta fallita e la versione in linea resta quella di prima.
 */
export async function runPublication(supabase: SupabaseClient, pack: string): Promise<PublicationResult> {
  const { compilePublication, mediaPaths, PREMIUM_BUCKET, removeDeadPremium, removeDeadVersions, uploadRetrying } = await import("./publish");
  const started = Date.now();
  // Una pubblicazione alla volta per territorio: senza la presa in carico non si tocca il bucket.
  const claim = await supabase.rpc("studio_publication_claim", { p_pack: pack });
  if (claim.error) return { ok: false, errors: [`pubblicazione non avviata: ${claim.error.message}`], warnings: [], bundles: [] };
  const claimed = claim.data as { ok?: boolean; publication?: string } | null;
  if (claimed?.ok !== true || typeof claimed.publication !== "string") {
    return { ok: false, errors: ["è già in corso un'altra pubblicazione di questo territorio: riprova tra qualche minuto"], warnings: [], bundles: [] };
  }
  // Ogni esito, riuscito o fallito, va alla pubblicazione presa in carico e a nessun'altra.
  const publication = claimed.publication;
  // Rinnovo della presa in carico, da chiedere subito prima di ogni operazione che cambia i file pubblicati: un
  // controllo vale solo per l'operazione che lo segue. Un errore di rete conta come presa persa.
  const stillHeld = async () => {
    const { data, error } = await supabase.rpc("studio_publication_renew", { p_pack: pack, p_publication: publication });
    return !error && data === true;
  };
  const LOST = "presa in carico della pubblicazione persa (scaduta o sostituita da un'altra pubblicazione): la pubblicazione si ferma senza toccare altri manifest o file";
  const fail = async (errors: string[], warnings: string[] = []): Promise<PublicationResult> => {
    await supabase.rpc("studio_publication_finish", {
      p_pack: pack, p_ok: false, p_report: { errors, warnings, ms: Date.now() - started }, p_bundles: [], p_publication: publication,
    });
    return { ok: false, errors, warnings, bundles: [] };
  };
  try {
    const snapshots = await loadSnapshots(supabase, pack);
    const files = new Map<string, Uint8Array>();
    await pool(mediaPaths(snapshots), 4, async (path) => {
      const { data } = await supabase.storage.from(MEDIA_BUCKET).download(path);
      if (data) files.set(path, new Uint8Array(await data.arrayBuffer()));
    });
    const compiled = compilePublication(pack, snapshots, files, await staticDestinations(), publication);
    if (!compiled.ok) return await fail(compiled.errors, compiled.warnings);

    const bucket = supabase.storage.from(BUNDLES_BUCKET);
    for (const b of compiled.bundles) {
      // Media condivisi (impronta nel nome): quelli già presenti non si ricaricano. I file della pubblicazione
      // vanno nella sua cartella, sempre nuovi; nessun file si sovrascrive (upsert: false, e il bucket lo impone).
      const present = new Set<string>();
      const { data: media } = await bucket.list(`${b.folder}/media`, { limit: 1000 });
      for (const f of media ?? []) present.add(`media/${f.name}`);
      const uploads = [...b.immutable, ...b.stream].filter(([p]) => !present.has(p));
      const failures: string[] = [];
      // Pochi caricamenti insieme e nuovi tentativi sugli errori temporanei: lo Storage di Supabase, sovraccarico,
      // risponde «Too many connections issued to the database» (successo il 2026-10-18 con i file dei singoli luoghi).
      await pool(uploads, 3, async ([path, data]) => {
        const up = await uploadRetrying(() => bucket.upload(`${b.folder}/${path}`, data, { contentType: contentType(path), upsert: false, cacheControl: IMMUTABLE }));
        const shared = path.startsWith("media/") && /exist|duplicate/i.test(up.error?.message ?? "");
        if (up.error && !shared) failures.push(`${b.folder}/${path}: ${up.error.message}`);
      });
      // Parti a pagamento: nel bucket privato, mai in quello pubblico (le policy leggono solo con il diritto).
      await pool([...b.premium], 3, async ([path, data]) => {
        const up = await uploadRetrying(() => supabase.storage.from(PREMIUM_BUCKET).upload(path, data, { contentType: "application/json", upsert: false }));
        if (up.error) failures.push(`premium ${path}: ${up.error.message}`);
      });
      if (failures.length) return await fail(failures, compiled.warnings);
      // Tiene viva la presa in carico di una pubblicazione lunga; persa, ci si ferma prima di altri caricamenti.
      if (!(await stillHeld())) return await fail([LOST], compiled.warnings);
    }
    // Manifest per ultimi, nella cartella della pubblicazione. Finché la pubblicazione non va in linea (esito sotto)
    // nessuno li legge: l'indice in vigore punta ancora alla versione precedente.
    for (const b of compiled.bundles) {
      if (!(await stillHeld())) return await fail([LOST], compiled.warnings);
      const up = await uploadRetrying(() => bucket.upload(`${b.folder}/${b.manifestPath}`, new TextEncoder().encode(b.manifestJson), {
        contentType: "application/json", upsert: false, cacheControl: IMMUTABLE,
      }));
      if (up.error) return await fail([`${b.folder}/${b.manifestPath}: ${up.error.message}`], compiled.warnings);
    }
    // Verifica prima di andare in linea: ogni file che il manifest e i video richiedono è nel bucket.
    const missing: string[] = [];
    for (const b of compiled.bundles) {
      const dirs = new Map<string, Set<string>>();
      for (const path of [b.manifestPath, ...b.immutable.keys(), ...b.stream.keys()]) {
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (!dirs.has(dir)) {
          const { data } = await bucket.list(dir ? `${b.folder}/${dir}` : b.folder, { limit: 1000 });
          dirs.set(dir, new Set((data ?? []).map((f) => f.name)));
        }
        if (!dirs.get(dir)!.has(path.slice(path.lastIndexOf("/") + 1))) missing.push(`${b.folder}/${path}`);
      }
    }
    for (const b of compiled.bundles) {
      const dirs = new Map<string, Set<string>>();
      for (const path of b.premium.keys()) {
        const dir = path.slice(0, path.lastIndexOf("/"));
        if (!dirs.has(dir)) {
          const { data } = await supabase.storage.from(PREMIUM_BUCKET).list(dir, { limit: 1000 });
          dirs.set(dir, new Set((data ?? []).map((f) => f.name)));
        }
        if (!dirs.get(dir)!.has(path.slice(path.lastIndexOf("/") + 1))) missing.push(`premium ${path}`);
      }
    }
    if (missing.length) return await fail([`file mancanti nel bucket: ${missing.slice(0, 5).join(", ")}`], compiled.warnings);
    const warnings = [...compiled.warnings];
    const summary = compiled.bundles.map((b) => ({ locale: b.locale, totalBytes: b.manifest.totalBytes, places: b.places, units: b.units }));
    // In linea: l'esito per identificativo (rifiutato se la presa in carico è stata persa) registra le nuove voci.
    const { error } = await supabase.rpc("studio_publication_finish", {
      p_pack: pack,
      p_ok: true,
      p_report: { warnings, ms: Date.now() - started, bundles: summary },
      p_bundles: compiled.bundles.map((b) => ({ locale: b.locale, url: b.entry.manifest, manifest: b.manifest, entry: b.entry })),
      p_publication: publication,
    });
    if (error) return { ok: false, errors: [error.message], warnings, bundles: [] };
    const indexError = await refreshPublicIndex(supabase);
    if (!indexError) {
      // Pulizia: solo versioni morte e non usate dall'indice in vigore (vedi removeDeadVersions). Non serve alla
      // correttezza: se non riesce i file restano, orfani.
      const visible = await visibleIndex(supabase);
      const dead = await supabase.rpc("studio_publication_dead_ids", { p_pack: pack });
      if (!visible || dead.error) warnings.push("versioni precedenti non cancellate (indice in vigore o pubblicazioni non leggibili)");
      else {
        const deadIds = (dead.data as string[] | null) ?? [];
        warnings.push(...await removeDeadVersions(bucket, compiled.bundles.map((b) => b.folder), visible, deadIds, publication));
        warnings.push(...await removeDeadPremium(supabase.storage.from(PREMIUM_BUCKET), pack, compiled.bundles.map((b) => b.locale), visible, deadIds, publication));
      }
    }
    return {
      ok: !indexError,
      errors: indexError ? [`bundle pubblicati ma indice non aggiornato: ${indexError}`] : [],
      warnings,
      bundles: summary,
    };
  } catch (e) {
    return await fail([e instanceof Error ? e.message : String(e)]);
  }
}
