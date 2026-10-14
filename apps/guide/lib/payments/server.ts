/**
 * Pagamenti, lato server: client Stripe e collegamento delle dipendenze di flows.ts. Solo codice del server: le
 * chiavi (Stripe e ruolo di servizio di Supabase) non arrivano mai al browser.
 *
 * La chiave di servizio serve solo al webhook (decisione D7: nella richiesta di Stripe non c'è un utente) e solo per
 * le funzioni payment_* del database; il checkout usa l'identità dell'utente.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import type { AccountConfig } from "../account/shared";
import type { CheckoutDeps, Rpc, WebhookDeps } from "./flows";
import { paymentsEnv, readPaymentsConfig, type PaymentsConfig, type PaymentsSetup, type SessionState } from "./shared";

export function paymentsSetup(): PaymentsSetup {
  return readPaymentsConfig(paymentsEnv());
}

export function stripeClient(config: PaymentsConfig): Stripe {
  return new Stripe(config.secretKey, {
    // Le richieste che creano qualcosa portano una chiave di idempotenza: un nuovo tentativo non duplica nulla.
    maxNetworkRetries: 1,
    timeout: 20_000,
    telemetry: false,
    ...(config.apiBase ? { protocol: config.apiBase.protocol, host: config.apiBase.host, port: config.apiBase.port } : {}),
  });
}

export const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ area: "payments", ...entry }));

const rpcOf = (supabase: SupabaseClient): Rpc => async (fn, args) => {
  const { data, error } = await supabase.rpc(fn, args);
  return { data, error: error ? { message: error.message, code: error.code } : null };
};

const sessionState = (s: Stripe.Checkout.Session): SessionState => ({
  id: s.id, status: s.status, payment_status: s.payment_status, client_reference_id: s.client_reference_id,
  amount_total: s.amount_total, currency: s.currency, payment_intent: s.payment_intent, customer: s.customer,
});

export function checkoutDeps(config: PaymentsConfig, userClient: SupabaseClient): CheckoutDeps {
  const stripe = stripeClient(config);
  return {
    rpc: rpcOf(userClient),
    stripe: {
      createSession: async (params, idempotencyKey) => {
        const s = await stripe.checkout.sessions.create(params, { idempotencyKey });
        return { id: s.id, url: s.url };
      },
      expireSession: async (id) => {
        await stripe.checkout.sessions.expire(id);
      },
      retrieveSession: async (id) => sessionState(await stripe.checkout.sessions.retrieve(id)),
    },
    log,
  };
}

export function webhookDeps(config: PaymentsConfig, account: AccountConfig): WebhookDeps {
  const stripe = stripeClient(config);
  const service = createClient(account.supabase.url, config.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    verify: (raw, signature) => stripe.webhooks.constructEvent(raw, signature, config.webhookSecret) as unknown as ReturnType<WebhookDeps["verify"]>,
    retrieveSession: async (id) => sessionState(await stripe.checkout.sessions.retrieve(id)),
    retrieveCharge: async (id) => {
      const c = await stripe.charges.retrieve(id);
      return { id: c.id, amount_refunded: c.amount_refunded, payment_intent: c.payment_intent };
    },
    retrieveDispute: async (id) => {
      const d = await stripe.disputes.retrieve(id);
      return { id: d.id, status: d.status, payment_intent: d.payment_intent, charge: d.charge };
    },
    rpc: rpcOf(service),
    log,
  };
}
