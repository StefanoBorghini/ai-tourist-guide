/**
 * Webhook di Stripe: firma verificata sul corpo grezzo, evento registrato una volta sola, stato riletto da Stripe e
 * applicato con le funzioni payment_* del database (ruolo di servizio). Vedi docs/v0.3-platform/PAGAMENTI.md.
 * Risponde 400 a una firma non valida (nessun effetto) e 500 se l'elaborazione non riesce: Stripe riprova.
 */
import { NextResponse } from "next/server";
import { accountSetup } from "../../../../lib/account/server";
import { handleWebhook } from "../../../../lib/payments/flows";
import { log, paymentsSetup, webhookDeps } from "../../../../lib/payments/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const account = accountSetup();
  const payments = paymentsSetup();
  if (!account.ok || !payments.ok) {
    log({ event: "webhook_not_configured" });
    return NextResponse.json({ error: "pagamenti non configurati" }, { status: 503 });
  }
  const raw = await request.text();
  const result = await handleWebhook(raw, request.headers.get("stripe-signature"), webhookDeps(payments.config, account.config));
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
