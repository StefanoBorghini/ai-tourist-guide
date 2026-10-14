"use server";
/**
 * Azioni degli account dei visitatori. Ognuna rilegge la configurazione e l'utente sul server; gli esiti tornano
 * nella pagina come codici (?ok= / ?errore=), mai come testo (lib/account/shared.ts).
 * Stessa risposta per email registrate e non (registrazione e recupero): nessuno scopre chi ha un account.
 */
import { redirect } from "next/navigation";
import { accountClient, accountSetup, recordConsents, requireVisitor, siteOrigin } from "../../lib/account/server";
import {
  authErrorCode,
  checkPassword,
  DELETE_CONFIRMATION,
  EMAIL_RE,
  OAUTH_PROVIDERS,
  safeNext,
  SIGN_IN,
  type ErrorCode,
  type MessageCode,
  type OAuthProvider,
} from "../../lib/account/shared";

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const go = (path: string, q: { ok?: MessageCode; errore?: ErrorCode; next?: string } = {}): never => {
  const params = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1]));
  redirect(params.size ? `${path}?${params}` : path);
};
const configured = () => {
  const setup = accountSetup();
  if (!setup.ok) go(SIGN_IN);
  return setup.ok ? setup.config : (null as never);
};

// ---------------------------------------------------------------- accesso

export async function signIn(form: FormData) {
  const config = configured();
  const next = safeNext(text(form, "next"));
  const supabase = await accountClient(config);
  const { data, error } = await supabase.auth.signInWithPassword({ email: text(form, "email"), password: String(form.get("password") ?? "") });
  if (error || !data.user) go(SIGN_IN, { errore: error ? authErrorCode(error) : "servizio", next });
  await recordConsents(supabase, data.user!);
  go(next);
}

export async function signUp(form: FormData) {
  const config = configured();
  const email = text(form, "email");
  const password = String(form.get("password") ?? "");
  if (!EMAIL_RE.test(email)) go("/account/registrati", { errore: "email" });
  const bad = checkPassword(password, String(form.get("confirm") ?? ""));
  if (bad) go("/account/registrati", { errore: bad as ErrorCode });
  if (form.get("terms") !== "on" || form.get("privacy") !== "on") go("/account/registrati", { errore: "consensi" });
  const locale = form.get("locale") === "en" ? "en" : "it";
  const supabase = await accountClient(config);
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${await siteOrigin()}/auth/confirm?next=/account`,
      // Consensi e lingua nei metadati: prima della conferma non c'è sessione per scriverli nel database.
      data: { locale, consents: { version: config.legal.version, terms: true, privacy: true } },
    },
  });
  // Un indirizzo già registrato riceve la stessa risposta di uno nuovo (Supabase non rivela nulla).
  if (error) go("/account/registrati", { errore: authErrorCode(error) });
  if (data.session && data.user) {
    // Conferma dell'email disattivata nel progetto: sessione subito (sconsigliato in produzione).
    await recordConsents(supabase, data.user);
    go("/account");
  }
  go(SIGN_IN, { ok: "controlla-email" });
}

export async function requestPasswordReset(form: FormData) {
  const config = configured();
  const email = text(form, "email");
  if (!EMAIL_RE.test(email)) go("/account/password", { errore: "email" });
  const supabase = await accountClient(config);
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${await siteOrigin()}/auth/confirm?next=/auth/reimposta` });
  // Solo il limite di invio si dice; per il resto la stessa risposta, registrato o no.
  if (error && authErrorCode(error) === "troppi-tentativi") go("/account/password", { errore: "troppi-tentativi" });
  go(SIGN_IN, { ok: "email-recupero" });
}

export async function updatePassword(form: FormData) {
  const { supabase } = await requireVisitor("/auth/reimposta");
  const password = String(form.get("password") ?? "");
  const bad = checkPassword(password, String(form.get("confirm") ?? ""));
  if (bad) go("/auth/reimposta", { errore: bad as ErrorCode });
  const { error } = await supabase.auth.updateUser({ password });
  if (error) go("/auth/reimposta", { errore: authErrorCode(error) });
  go("/account", { ok: "password-aggiornata" });
}

export async function signInWith(form: FormData) {
  const config = configured();
  const provider = text(form, "provider") as OAuthProvider;
  if (!(OAUTH_PROVIDERS as readonly string[]).includes(provider) || !config.providers.includes(provider)) go(SIGN_IN, { errore: "metodo" });
  const next = safeNext(text(form, "next"));
  const supabase = await accountClient(config);
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${await siteOrigin()}/auth/callback?next=${encodeURIComponent(next)}` },
  });
  if (error || !data.url) go(SIGN_IN, { errore: error ? authErrorCode(error) : "servizio" });
  redirect(data.url!);
}

// ---------------------------------------------------------------- profilo

export async function updateProfile(form: FormData) {
  const { supabase, user } = await requireVisitor();
  const name = text(form, "display_name");
  if (name.length > 80) go("/account", { errore: "nome" });
  const locale = form.get("locale") === "en" ? "en" : "it";
  const { error } = await supabase.from("profiles").update({ display_name: name || null, preferred_locale: locale, updated_at: new Date().toISOString() }).eq("user_id", user.id);
  if (error) go("/account", { errore: "servizio" });
  go("/account", { ok: "profilo-salvato" });
}

/** Collegamento esplicito di un accesso social all'account già aperto (mai automatico per email). */
export async function linkProvider(form: FormData) {
  const { supabase, config } = await requireVisitor();
  const provider = text(form, "provider") as OAuthProvider;
  if (!config.providers.includes(provider)) go("/account", { errore: "metodo" });
  const { data, error } = await supabase.auth.linkIdentity({
    provider,
    options: { redirectTo: `${await siteOrigin()}/auth/callback?next=/account&collega=1` },
  });
  if (error || !data.url) go("/account", { errore: error ? authErrorCode(error) : "servizio" });
  redirect(data.url!);
}

export async function signOut(form: FormData) {
  const setup = accountSetup();
  const everywhere = form.get("scope") === "global";
  if (setup.ok) await (await accountClient(setup.config)).auth.signOut({ scope: everywhere ? "global" : "local" });
  go(SIGN_IN, { ok: everywhere ? "uscito-ovunque" : "uscito" });
}

/** Eliminazione dell'account: delete_my_account() cancella l'utente e, a cascata, profilo, consensi e diritti. */
export async function deleteAccount(form: FormData) {
  const { supabase } = await requireVisitor("/account/elimina");
  if (text(form, "confirm") !== DELETE_CONFIRMATION) go("/account/elimina", { errore: "conferma-eliminazione" });
  const { error } = await supabase.rpc("delete_my_account");
  if (error) {
    console.error(JSON.stringify({ event: "account_delete_error", code: error.code }));
    go("/account/elimina", { errore: "servizio" });
  }
  // La sessione non vale più: si tolgono i cookie su questo dispositivo.
  await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
  go(SIGN_IN, { ok: "eliminato" });
}
