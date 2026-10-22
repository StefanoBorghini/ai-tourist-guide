/**
 * GET /auth/confirm — link delle email di Supabase (conferma dell'indirizzo, recupero della password).
 *
 * Due forme, entrambe accettate:
 * - `?token_hash=…&type=…` (modello email consigliato in docs/v0.3-platform/ACCOUNT.md): funziona anche se il link
 *   si apre su un altro dispositivo;
 * - `?code=…` (modello predefinito di Supabase, flusso PKCE): funziona solo nel browser che ha chiesto l'email.
 * Poi: consensi della registrazione nel database e pagina successiva (solo interna, safeNext).
 */
import type { EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { accountClient, accountSetup, recordConsents } from "../../../lib/account/server";
import { safeNext, SIGN_IN } from "../../../lib/account/shared";

const OTP_TYPES: EmailOtpType[] = ["signup", "email", "recovery", "email_change", "invite", "magiclink"];

export async function GET(request: NextRequest) {
  const setup = accountSetup();
  if (!setup.ok) redirect(SIGN_IN);
  const q = request.nextUrl.searchParams;
  const type = q.get("type") as EmailOtpType | null;
  const tokenHash = q.get("token_hash");
  const code = q.get("code");
  const next = type === "recovery" ? "/auth/reimposta" : safeNext(q.get("next"));

  const supabase = await accountClient(setup.config);
  let ok = false;
  if (tokenHash && type && OTP_TYPES.includes(type)) {
    ok = !(await supabase.auth.verifyOtp({ type, token_hash: tokenHash })).error;
  } else if (code) {
    ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  }
  if (!ok) redirect(`${SIGN_IN}?errore=link`);
  const { data } = await supabase.auth.getUser();
  if (data.user) await recordConsents(supabase, data.user);
  redirect(next);
}
