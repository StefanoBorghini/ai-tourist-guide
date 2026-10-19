/**
 * Client Supabase per le letture pubbliche dal server: chiave anonima, nessun cookie, nessuna sessione.
 *
 * Serve alle route che rispondono uguale per tutti e possono stare nella cache della CDN (eventi del giorno): non
 * legge i cookie della richiesta, quindi la risposta non può dipendere da chi la chiede. Mai la chiave di servizio:
 * decidono le funzioni pubbliche del database e le loro regole. Null se Supabase non è configurato.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readStudioConfig } from "./studio/shared";

let cached: SupabaseClient | null | undefined;

export function publicSupabase(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  // Variabili nominate una per una: Next sostituisce le NEXT_PUBLIC_* solo così.
  const config = readStudioConfig({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  cached = config
    ? createClient(config.url, config.anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    : null;
  return cached;
}
