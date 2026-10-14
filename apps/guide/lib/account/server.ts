/**
 * Account dei visitatori, lato server: client Supabase con la sessione nei cookie e utente verificato.
 *
 * L'utente si legge sempre con getUser() (verificato dal server di autenticazione, non il solo cookie). Tutti i dati
 * passano con l'identità dell'utente e le policy RLS «solo i propri» (profiles, consents, export_my_data,
 * delete_my_account): nessuna chiave di servizio. Un account visitatore non dà accesso allo Studio (serve un ruolo).
 */
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { accountEnv, consentsToRecord, readAccountConfig, SIGN_IN, type AccountConfig, type AccountSetup } from "./shared";

export function accountSetup(): AccountSetup {
  return readAccountConfig(accountEnv());
}

export async function accountClient(config: AccountConfig): Promise<SupabaseClient> {
  const store = await cookies();
  return createServerClient(config.supabase.url, config.supabase.anonKey, {
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

/**
 * Origine del sito per i link di conferma, recupero e accesso social. Supabase accetta solo gli indirizzi
 * dell'elenco «Redirect URLs» del progetto: un host falsificato non riceve mai il link.
 */
export async function siteOrigin(): Promise<string> {
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0]!.trim();
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) throw new Error("host non valido");
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const proto = (h.get("x-forwarded-proto") ?? "").split(",")[0]!.trim() || (local ? "http" : "https");
  return `${proto === "http" && local ? "http" : "https"}://${host}`;
}

export interface VisitorSession {
  supabase: SupabaseClient;
  user: User;
  config: AccountConfig;
}

/** Utente autenticato; altrimenti all'accesso, con il ritorno alla pagina richiesta. Senza configurazione: pagina principale dell'account. */
export async function requireVisitor(next = "/account"): Promise<VisitorSession> {
  const setup = accountSetup();
  if (!setup.ok) redirect(SIGN_IN);
  const supabase = await accountClient(setup.config);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) redirect(`${SIGN_IN}?errore=sessione&next=${encodeURIComponent(next)}`);
  return { supabase, user: data.user, config: setup.config };
}

/** Registra i consensi dati alla registrazione (nei metadati dell'utente) che non sono ancora nel database. */
export async function recordConsents(supabase: SupabaseClient, user: User): Promise<void> {
  const { data, error } = await supabase.from("consents").select("kind, version, granted").eq("user_id", user.id);
  if (error) {
    console.error(JSON.stringify({ event: "account_consents_error", step: "read", code: error.code }));
    return;
  }
  const rows = consentsToRecord(user.user_metadata, data ?? []);
  if (rows.length === 0) return;
  const insert = await supabase.from("consents").insert(rows.map((r) => ({ ...r, user_id: user.id })));
  if (insert.error) console.error(JSON.stringify({ event: "account_consents_error", step: "insert", code: insert.error.code }));
}
