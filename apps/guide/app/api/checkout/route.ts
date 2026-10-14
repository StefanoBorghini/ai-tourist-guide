/**
 * Avvio del pagamento: il modulo «Acquista» invia solo l'id del prodotto (e la destinazione, per tornare alla pagina
 * giusta). Utente, prezzo e importo li decide il server con checkout_open; la risposta è un redirect a Stripe o alla
 * pagina d'acquisto con un codice d'errore. Vedi docs/v0.3-platform/PAGAMENTI.md.
 */
import { NextResponse } from "next/server";
import { accountClient, accountSetup, siteOrigin } from "../../../lib/account/server";
import { SIGN_IN } from "../../../lib/account/shared";
import { startCheckout } from "../../../lib/payments/flows";
import { checkoutDeps, log, paymentsSetup } from "../../../lib/payments/server";
import { PACK_RE, shopPath } from "../../../lib/payments/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const see = (to: string, origin: string) => NextResponse.redirect(new URL(to, origin), 303);

export async function POST(request: Request) {
  let origin: string;
  try {
    origin = await siteOrigin();
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  // Solo moduli di questo sito: un altro sito non può avviare acquisti a nome del visitatore.
  if (request.headers.get("origin") !== origin) return new NextResponse(null, { status: 403 });
  const form = await request.formData().catch(() => null);
  const pack = String(form?.get("destinazione") ?? "");
  const productId = String(form?.get("prodotto") ?? "");
  if (!PACK_RE.test(pack) || pack.length > 120) return see("/account", origin);

  const account = accountSetup();
  const payments = paymentsSetup();
  if (!account.ok || !payments.ok) return see(`${shopPath(pack)}&errore=acquisti-spenti`, origin);
  const supabase = await accountClient(account.config);
  const { data } = await supabase.auth.getUser();
  if (!data.user) return see(`${SIGN_IN}?errore=sessione&next=${encodeURIComponent(shopPath(pack))}`, origin);

  try {
    const { redirect } = await startCheckout(
      { productId, pack, user: { id: data.user.id, email: data.user.email }, origin, now: Date.now() },
      checkoutDeps(payments.config, supabase),
    );
    return see(redirect, origin);
  } catch (e) {
    log({ event: "checkout_unexpected", error: e instanceof Error ? e.message.slice(0, 200) : "?" });
    return see(`${shopPath(pack)}&errore=servizio`, origin);
  }
}
