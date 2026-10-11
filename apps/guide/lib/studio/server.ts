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
import { BUNDLES_BUCKET } from "../bundle-index";
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
  return assessReadiness(pack, snapshots, stored);
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

/** Indice pubblico (index.json nel bucket «bundles») ricalcolato dal database: chi è in linea e con quale versione. */
export async function refreshPublicIndex(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.rpc("public_bundle_index");
  if (error) return error.message;
  const up = await supabase.storage.from(BUNDLES_BUCKET).upload("index.json", new TextEncoder().encode(JSON.stringify(data)), {
    contentType: "application/json", upsert: true, cacheControl: MUTABLE,
  });
  return up.error ? up.error.message : null;
}

/**
 * Pipeline di pubblicazione, con la sessione di chi pubblica (le policy decidono cosa può scrivere):
 * istantanee → file media dal bucket «media» → compilazione e verifica → file nel bucket «bundles»
 * (prima quelli con l'impronta, poi i manifest) → esito nel database → indice pubblico.
 * Se qualcosa va storto la pubblicazione risulta fallita e la versione in linea resta quella di prima.
 */
export async function runPublication(supabase: SupabaseClient, pack: string): Promise<PublicationResult> {
  const { compilePublication, mediaPaths } = await import("./publish");
  const started = Date.now();
  const fail = async (errors: string[], warnings: string[] = []): Promise<PublicationResult> => {
    await supabase.rpc("studio_publication_finish", { p_pack: pack, p_ok: false, p_report: { errors, warnings, ms: Date.now() - started } });
    return { ok: false, errors, warnings, bundles: [] };
  };
  try {
    const snapshots = await loadSnapshots(supabase, pack);
    const files = new Map<string, Uint8Array>();
    await pool(mediaPaths(snapshots), 4, async (path) => {
      const { data } = await supabase.storage.from(MEDIA_BUCKET).download(path);
      if (data) files.set(path, new Uint8Array(await data.arrayBuffer()));
    });
    const compiled = compilePublication(pack, snapshots, files);
    if (!compiled.ok) return await fail(compiled.errors, compiled.warnings);

    const bucket = supabase.storage.from(BUNDLES_BUCKET);
    for (const b of compiled.bundles) {
      // I file con l'impronta già presenti (pubblicazioni precedenti) non si ricaricano.
      const present = new Set<string>();
      for (const dir of ["", "media"]) {
        const { data } = await bucket.list(dir ? `${b.folder}/${dir}` : b.folder, { limit: 1000 });
        for (const f of data ?? []) present.add(dir ? `${dir}/${f.name}` : f.name);
      }
      const uploads = [...b.immutable, ...b.stream].filter(([p]) => !present.has(p));
      const failures: string[] = [];
      await pool(uploads, 4, async ([path, data]) => {
        const up = await bucket.upload(`${b.folder}/${path}`, data, { contentType: contentType(path), upsert: false, cacheControl: IMMUTABLE });
        if (up.error && !/exist|duplicate/i.test(up.error.message)) failures.push(`${b.folder}/${path}: ${up.error.message}`);
      });
      if (failures.length) return await fail(failures, compiled.warnings);
    }
    // Manifest per ultimi: finché non cambiano, l'app continua a usare la versione precedente completa.
    for (const b of compiled.bundles) {
      const up = await bucket.upload(`${b.folder}/manifest.json`, new TextEncoder().encode(b.manifestJson), {
        contentType: "application/json", upsert: true, cacheControl: MUTABLE,
      });
      if (up.error) return await fail([`${b.folder}/manifest.json: ${up.error.message}`], compiled.warnings);
    }
    const summary = compiled.bundles.map((b) => ({ locale: b.locale, totalBytes: b.manifest.totalBytes, places: b.places, units: b.units }));
    const { error } = await supabase.rpc("studio_publication_finish", {
      p_pack: pack,
      p_ok: true,
      p_report: { warnings: compiled.warnings, ms: Date.now() - started, bundles: summary },
      p_bundles: compiled.bundles.map((b) => ({ locale: b.locale, url: b.entry.manifest, manifest: b.manifest, entry: b.entry })),
    });
    if (error) return { ok: false, errors: [error.message], warnings: compiled.warnings, bundles: [] };
    const indexError = await refreshPublicIndex(supabase);
    return {
      ok: !indexError,
      errors: indexError ? [`bundle pubblicati ma indice non aggiornato: ${indexError}`] : [],
      warnings: compiled.warnings,
      bundles: summary,
    };
  } catch (e) {
    return await fail([e instanceof Error ? e.message : String(e)]);
  }
}
