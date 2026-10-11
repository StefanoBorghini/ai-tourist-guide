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
import { readStudioConfig, type StudioConfig } from "./shared";

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
export async function checkReadiness(supabase: SupabaseClient, pack: string) {
  const { assessReadiness } = await import("./readiness");
  const snapshots = new Map<string, Record<string, unknown> | null>();
  const load = async (id: string) => {
    if (snapshots.has(id)) return;
    const { data } = await supabase.rpc("pack_snapshot", { p_pack: id });
    snapshots.set(id, (data ?? null) as Record<string, unknown> | null);
    const deps = ((data as { manifest?: { dependsOn?: string[] } } | null)?.manifest?.dependsOn ?? []);
    for (const d of deps) await load(d);
  };
  await load(pack);
  const target = snapshots.get(pack) as { media?: { file: string; poster?: string }[] } | null;
  const paths = (target?.media ?? []).flatMap((m) => [m.file, ...(m.poster ? [m.poster] : [])]).map((f) => `${pack}/${f}`);
  const stored = new Set((await signedMediaUrls(supabase, paths)).keys());
  return assessReadiness(pack, snapshots, stored);
}
