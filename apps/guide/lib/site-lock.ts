/**
 * Accesso al sito protetto con nome utente e password (autenticazione di base HTTP), per tenere privato il progetto
 * online finché non è pubblico. Logica pura, testata; la applica proxy.ts a ogni richiesta.
 *
 * Si accende solo se sono impostate entrambe le variabili del server SITE_USERNAME e SITE_PASSWORD (mai NEXT_PUBLIC_:
 * non arrivano al browser). Senza, il sito funziona come prima. Le credenziali non si scrivono nel codice né nei log.
 * Resta aperto solo il webhook di Stripe, che non può autenticarsi così e ha già la sua firma.
 */

export interface SiteLock {
  username: string;
  password: string;
}

/** Percorsi che non chiedono la password: chiamate di servizi esterni con una loro verifica. */
const EXEMPT = [/^\/api\/stripe\/webhook\/?$/];

export const SITE_LOCK_REALM = "AI Guide";

/** Configurazione dalle variabili d'ambiente; null = protezione spenta. */
export function siteLockFromEnv(env: { SITE_USERNAME?: string; SITE_PASSWORD?: string }): SiteLock | null {
  const username = env.SITE_USERNAME?.trim() ?? "";
  const password = env.SITE_PASSWORD ?? "";
  if (!username || !password) return null;
  return { username, password };
}

export const isExempt = (pathname: string) => EXEMPT.some((re) => re.test(pathname));

/** Confronto a tempo costante (non rivela quanti caratteri iniziali coincidono). */
function sameText(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Vero se l'intestazione Authorization porta proprio queste credenziali (schema Basic, UTF-8). */
export function authorized(header: string | null, lock: SiteLock): boolean {
  if (!header) return false;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!match) return false;
  let decoded: string;
  try {
    const bytes = Uint8Array.from(atob(match[1]!), (c) => c.charCodeAt(0));
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  // Entrambi i confronti sempre eseguiti: il tempo non dice quale dei due è sbagliato.
  const userOk = sameText(decoded.slice(0, sep), lock.username);
  const passOk = sameText(decoded.slice(sep + 1), lock.password);
  return userOk && passOk;
}

/** Decide per una richiesta: null = passa; altrimenti la risposta 401 da dare (senza dettagli). */
export function siteLockDecision(pathname: string, header: string | null, lock: SiteLock | null): { status: 401; headers: Record<string, string> } | null {
  if (!lock || isExempt(pathname) || authorized(header, lock)) return null;
  return {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm="${SITE_LOCK_REALM}", charset="UTF-8"`,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  };
}
