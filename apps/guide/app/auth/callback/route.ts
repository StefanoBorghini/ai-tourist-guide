/**
 * GET /auth/callback — ritorno dall'accesso social (Google, Apple) e dal collegamento di un metodo al profilo.
 * Scambia il codice con la sessione (PKCE: stesso browser). Errori e annullamenti tornano all'accesso come codici.
 */
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { accountClient, accountSetup, recordConsents } from "../../../lib/account/server";
import { authErrorCode, safeNext, SIGN_IN } from "../../../lib/account/shared";

export async function GET(request: NextRequest) {
  const setup = accountSetup();
  if (!setup.ok) redirect(SIGN_IN);
  const q = request.nextUrl.searchParams;
  const linking = q.get("collega") === "1";
  const back = linking ? "/account" : SIGN_IN;

  // Errore restituito dal provider o da Supabase (annullato, identità già usata, link scaduto…).
  const failure = q.get("error_code") ?? q.get("error");
  if (failure) {
    const errore = failure === "access_denied" ? "annullato" : authErrorCode({ code: failure });
    redirect(`${back}?errore=${errore}`);
  }
  const code = q.get("code");
  if (!code) redirect(`${back}?errore=link`);

  const supabase = await accountClient(setup.config);
  const { data, error } = await supabase.auth.exchangeCodeForSession(code!);
  // Codice scaduto, già usato o aperto in un altro browser (manca il verificatore PKCE): «link non valido».
  if (error || !data.user) redirect(`${back}?errore=${error && authErrorCode(error) === "troppi-tentativi" ? "troppi-tentativi" : "link"}`);
  await recordConsents(supabase, data.user!);
  redirect(linking ? "/account?ok=collegato" : safeNext(q.get("next")));
}
