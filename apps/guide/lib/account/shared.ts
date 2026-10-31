/**
 * Account dei visitatori: regole pure condivise tra server e browser (testate in test/account.test.ts).
 *
 * Gli account servono solo ad acquistare e a ritrovare gli acquisti: tutto ciò che serve a visitare funziona senza.
 * Si attivano con NEXT_PUBLIC_ACCOUNTS_ENABLED=1 e solo se ci sono anche Supabase e i testi legali (condizioni,
 * informativa e loro versione): senza, le pagine dicono che gli account non sono ancora disponibili.
 * Vedi docs/v0.3-platform/ACCOUNT.md.
 */
import { readStudioConfig, type StudioConfig } from "../studio/shared";

export const OAUTH_PROVIDERS = ["google", "apple"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
export const PROVIDER_LABEL: Record<OAuthProvider, string> = { google: "Google", apple: "Apple" };

export interface AccountConfig {
  supabase: StudioConfig;
  /** Accessi social attivi (configurati anche in Supabase). Vuoto = solo email e password. */
  providers: OAuthProvider[];
  legal: { termsUrl: string; privacyUrl: string; version: string };
}

export type AccountSetup = { ok: true; config: AccountConfig } | { ok: false; missing: string[] };

/** https, oppure un percorso dello stesso sito ("/privacy"). */
const legalUrl = (raw: string | undefined) => {
  const v = raw?.trim();
  return v && (/^https:\/\/[^\s]+$/.test(v) || /^\/[^/\\\s][^\s]*$/.test(v)) ? v : null;
};

export function readAccountConfig(env: Record<string, string | undefined>): AccountSetup {
  const missing: string[] = [];
  if (env.NEXT_PUBLIC_ACCOUNTS_ENABLED?.trim() !== "1") missing.push("NEXT_PUBLIC_ACCOUNTS_ENABLED=1");
  const supabase = readStudioConfig(env);
  if (!supabase) missing.push("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const termsUrl = legalUrl(env.NEXT_PUBLIC_TERMS_URL);
  const privacyUrl = legalUrl(env.NEXT_PUBLIC_PRIVACY_URL);
  const version = env.NEXT_PUBLIC_LEGAL_VERSION?.trim();
  if (!termsUrl) missing.push("NEXT_PUBLIC_TERMS_URL");
  if (!privacyUrl) missing.push("NEXT_PUBLIC_PRIVACY_URL");
  if (!version || !/^[\w.-]{1,40}$/.test(version)) missing.push("NEXT_PUBLIC_LEGAL_VERSION");
  if (missing.length > 0) return { ok: false, missing };
  const providers = (env.NEXT_PUBLIC_AUTH_PROVIDERS ?? "")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p): p is OAuthProvider => (OAUTH_PROVIDERS as readonly string[]).includes(p));
  return { ok: true, config: { supabase: supabase!, providers: [...new Set(providers)], legal: { termsUrl: termsUrl!, privacyUrl: privacyUrl!, version: version! } } };
}

/** Variabili lette esplicitamente: Next sostituisce le NEXT_PUBLIC_* solo se nominate una per una. */
export const accountEnv = () => ({
  NEXT_PUBLIC_ACCOUNTS_ENABLED: process.env.NEXT_PUBLIC_ACCOUNTS_ENABLED,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_TERMS_URL: process.env.NEXT_PUBLIC_TERMS_URL,
  NEXT_PUBLIC_PRIVACY_URL: process.env.NEXT_PUBLIC_PRIVACY_URL,
  NEXT_PUBLIC_LEGAL_VERSION: process.env.NEXT_PUBLIC_LEGAL_VERSION,
  NEXT_PUBLIC_AUTH_PROVIDERS: process.env.NEXT_PUBLIC_AUTH_PROVIDERS,
});

// ------------------------------------------------------------------ percorsi

export const ACCOUNT_HOME = "/account";
export const SIGN_IN = "/account/accedi";
/** Pagine dell'account raggiungibili senza sessione. */
const PUBLIC_ACCOUNT_PAGES = new Set(["/account/accedi", "/account/registrati", "/account/password", "/account/conferma"]);

/** La pagina richiede un utente autenticato? (/auth/reimposta sì: ci si arriva con la sessione del link di recupero.) */
export function requiresSession(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (PUBLIC_ACCOUNT_PAGES.has(p)) return false;
  return p === "/account" || p.startsWith("/account/") || p === "/auth/reimposta";
}

/**
 * Destinazione dopo accesso, conferma o collegamento: solo percorsi interni noti, mai un altro sito
 * («//sito», «/\\sito», indirizzi assoluti) né pagine qualsiasi. Il resto torna a `fallback`.
 */
export function safeNext(raw: string | null | undefined, fallback = ACCOUNT_HOME): string {
  if (!raw || raw.length > 200) return fallback;
  // Percorso fatto solo di segmenti semplici (niente «..», «%», «\\», doppie barre) e query semplice.
  const m = /^(\/|\/account(?:\/[a-z0-9-]+)*|\/auth\/reimposta)(\?[\w=&.-]*)?$/.exec(raw);
  return m ? raw : fallback;
}

// ------------------------------------------------------------------ password

export const PASSWORD_MIN = 8;
/** bcrypt considera solo i primi 72 byte. */
export const PASSWORD_MAX = 72;

export function checkPassword(password: string, confirm?: string): string | null {
  if (password.length < PASSWORD_MIN) return "password-corta";
  if (new TextEncoder().encode(password).length > PASSWORD_MAX) return "password-lunga";
  if (confirm !== undefined && password !== confirm) return "password-diverse";
  return null;
}

// ------------------------------------------------------------------ messaggi

/**
 * Esiti e errori arrivano nell'indirizzo come codici, mai come testo libero: nessuno può far comparire un messaggio
 * inventato con un link. Codice sconosciuto → nessun messaggio.
 */
export const MESSAGES = {
  "controlla-email": "Ti abbiamo scritto: apri il link nell'email per confermare l'indirizzo, poi accedi.",
  "email-reinviata": "Se l'indirizzo è registrato e non ancora confermato, ti abbiamo inviato una nuova email di conferma.",
  "email-recupero": "Se l'indirizzo è registrato, riceverai un'email con il link per scegliere una nuova password.",
  "password-aggiornata": "Password aggiornata.",
  "profilo-salvato": "Profilo salvato.",
  "uscito": "Sei uscito dall'account.",
  "uscito-ovunque": "Sei uscito dall'account su tutti i dispositivi.",
  "eliminato": "Account eliminato. I dati collegati sono stati cancellati.",
  "collegato": "Metodo di accesso collegato.",
} as const;

export const ERRORS = {
  "credenziali": "Email o password non corrette.",
  "non-confermata": "Prima conferma l'indirizzo con il link che ti abbiamo inviato.",
  "password-corta": `La password deve avere almeno ${PASSWORD_MIN} caratteri.`,
  "password-lunga": "La password è troppo lunga.",
  "password-diverse": "Le due password non coincidono.",
  "password-debole": "La password è troppo semplice: scegline una più lunga o meno comune.",
  "stessa-password": "La nuova password deve essere diversa dalla precedente.",
  "email": "Scrivi un indirizzo email valido.",
  "consensi": "Per creare l'account servono l'accettazione delle condizioni e la presa visione dell'informativa.",
  "troppi-tentativi": "Troppi tentativi: riprova tra qualche minuto.",
  "registrazione-chiusa": "Le registrazioni non sono aperte in questo momento.",
  "link": "Il link non è valido o è scaduto: richiedine uno nuovo.",
  "annullato": "Accesso annullato.",
  "altro-metodo": "Questo indirizzo è già registrato con un altro metodo: accedi con quello, poi collega il nuovo metodo dal profilo.",
  "gia-collegato": "Questo metodo di accesso è già collegato a un altro account.",
  "metodo": "Metodo di accesso non disponibile.",
  "sessione": "Accedi per continuare.",
  "conferma-eliminazione": "Per eliminare l'account scrivi ELIMINA nel campo di conferma.",
  "nome": "Il nome può avere al massimo 80 caratteri.",
  "servizio": "Il servizio non risponde: riprova tra poco.",
  "invio-email": "In questo momento non riusciamo a inviare l'email: riprova tra qualche minuto. Se continua, scrivici.",
  "gia-acquistato": "Hai già acquistato questo contenuto: lo trovi in «I miei acquisti».",
  "esaurito": "Questo contenuto al momento non è acquistabile.",
  "non-pubblicata": "Questa destinazione non è ancora disponibile per gli acquisti.",
  "non-in-vendita": "Questo contenuto non è in vendita.",
  "gia-completo": "Hai già tutti i contenuti compresi in questo pacchetto.",
  "sotto-minimo": "Quello che ti manca costa meno di 0,50 €, il minimo per un pagamento: acquista i contenuti che mancano uno per uno.",
  "acquisti-spenti": "Gli acquisti non sono ancora attivi.",
  "pagamento-in-corso": "C'è un pagamento appena concluso per questo contenuto: attendi la conferma in «I miei acquisti».",
} as const;
export type MessageCode = keyof typeof MESSAGES;
export type ErrorCode = keyof typeof ERRORS;

// Object.hasOwn: «toString» e simili non devono contare come codici.
export const messageText = (code: string | undefined) => (code && Object.hasOwn(MESSAGES, code) ? MESSAGES[code as MessageCode] : null);
export const errorText = (code: string | undefined) => (code && Object.hasOwn(ERRORS, code) ? ERRORS[code as ErrorCode] : null);

/** Errore di Supabase Auth → codice del messaggio per il visitatore (mai il testo originale). */
export function authErrorCode(error: { code?: string; status?: number; message?: string }): ErrorCode {
  const code = error.code ?? "";
  const msg = error.message ?? "";
  if (code === "invalid_credentials" || /invalid login credentials/i.test(msg)) return "credenziali";
  if (code === "email_not_confirmed") return "non-confermata";
  if (code === "weak_password") return "password-debole";
  if (code === "same_password") return "stessa-password";
  if (code === "email_address_invalid" || code === "validation_failed") return "email";
  if (code === "signup_disabled" || code === "email_provider_disabled") return "registrazione-chiusa";
  if (code === "otp_expired" || code === "flow_state_expired" || code === "flow_state_not_found" || code === "bad_code_verifier") return "link";
  if (code === "identity_already_exists") return "gia-collegato";
  if (code === "email_exists" || code === "user_already_exists") return "altro-metodo";
  if (code === "provider_disabled" || code === "manual_linking_disabled") return "metodo";
  if (code.startsWith("over_") || error.status === 429) return "troppi-tentativi";
  // Il servizio email del progetto ha rifiutato l'invio (per esempio quello incluso in Supabase, che scrive solo agli
  // indirizzi del team): l'account può essere stato creato, ma l'email non parte.
  if (code === "email_address_not_authorized" || /error sending .*email/i.test(msg)) return "invio-email";
  return "servizio";
}

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export const DELETE_CONFIRMATION = "ELIMINA";

// ------------------------------------------------------------------ consensi

export type ConsentKind = "terms" | "privacy";

/**
 * Consensi dati alla registrazione: arrivano nei metadati dell'utente (prima della conferma non c'è sessione, quindi
 * non si possono scrivere nel database) e si registrano in `consents` al primo accesso. Solo quelli non già
 * registrati per la stessa versione.
 */
export function consentsToRecord(
  metadata: Record<string, unknown> | undefined,
  recorded: { kind: string; version: string; granted: boolean }[],
): { kind: ConsentKind; granted: true; version: string }[] {
  const given = metadata?.consents as { version?: unknown; terms?: unknown; privacy?: unknown } | undefined;
  if (!given || typeof given.version !== "string" || !/^[\w.-]{1,40}$/.test(given.version)) return [];
  const version = given.version;
  return (["terms", "privacy"] as const)
    .filter((kind) => given[kind] === true)
    .filter((kind) => !recorded.some((r) => r.kind === kind && r.version === version && r.granted))
    .map((kind) => ({ kind, granted: true as const, version }));
}
