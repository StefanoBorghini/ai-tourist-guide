/**
 * Pagamenti con Stripe: regole pure (testate in test/payments.test.ts). Vedi docs/v0.3-platform/PAGAMENTI.md.
 *
 * Solo modalità test: una chiave «live» spegne gli acquisti invece di attivarli. Il browser non riceve mai chiavi
 * Stripe né importi da rimandare: invia solo l'id del prodotto, il resto lo decide il database (checkout_open).
 * Il webhook non si fida del contenuto dell'evento: rilegge da Stripe sessione, addebito o contestazione e applica
 * l'esito con le funzioni payment_* del database (macchina a stati monotona, idempotente).
 */

export interface PaymentsConfig {
  secretKey: string;
  webhookSecret: string;
  serviceKey: string;
  /** Solo per le prove locali: un sostituto di api.stripe.com su localhost. */
  apiBase: { protocol: "http" | "https"; host: string; port: number } | null;
}

export type PaymentsSetup = { ok: true; config: PaymentsConfig } | { ok: false; missing: string[] };

export function readPaymentsConfig(env: Record<string, string | undefined>): PaymentsSetup {
  const missing: string[] = [];
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? "";
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (/^(sk|rk)_live_/.test(secretKey)) missing.push("STRIPE_SECRET_KEY di test (sk_test_…): le chiavi live non sono ammesse");
  else if (!/^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(secretKey)) missing.push("STRIPE_SECRET_KEY");
  if (!/^whsec_[A-Za-z0-9]{8,}$/.test(webhookSecret)) missing.push("STRIPE_WEBHOOK_SECRET");
  if (serviceKey.length < 20) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  let apiBase: PaymentsConfig["apiBase"] = null;
  const base = env.STRIPE_API_BASE?.trim();
  if (base) {
    const m = /^(http|https):\/\/(localhost|127\.0\.0\.1):(\d{2,5})$/.exec(base);
    if (!m) missing.push("STRIPE_API_BASE (solo http://localhost:porta, per le prove)");
    else apiBase = { protocol: m[1] as "http" | "https", host: m[2]!, port: Number(m[3]) };
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, config: { secretKey, webhookSecret, serviceKey, apiBase } };
}

/** Variabili solo server: nessuna è NEXT_PUBLIC, quindi non arrivano mai nel codice del browser. */
export const paymentsEnv = () => ({
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  STRIPE_API_BASE: process.env.STRIPE_API_BASE,
});

// ------------------------------------------------------------------ indirizzi e parametri

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Id di una destinazione (come nei Territory Pack). */
export const PACK_RE = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$/;

export const shopPath = (pack: string) => `/account/acquista?destinazione=${encodeURIComponent(pack)}`;
export const orderPath = (order: string) => `/account/ordine?id=${order}`;

/** Durata di una sessione di pagamento (il minimo che Stripe accetta). */
export const CHECKOUT_MINUTES = 30;

// ------------------------------------------------------------------ errori del checkout

/** Errore di checkout_open (messaggio del database) → codice per l'indirizzo. Mai il testo originale. */
export function checkoutErrorCode(message: string | undefined): string {
  const m = message ?? "";
  if (/già acquistato/.test(m)) return "gia-acquistato";
  if (/esaurito/.test(m)) return "esaurito";
  if (/non ancora pubblicata/.test(m)) return "non-pubblicata";
  if (/non in vendita|senza prezzo/.test(m)) return "non-in-vendita";
  if (/accedi/.test(m)) return "sessione";
  return "servizio";
}

// ------------------------------------------------------------------ stati degli ordini

export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "In attesa di pagamento",
  completed: "Pagato",
  failed: "Pagamento non riuscito",
  expired: "Scaduto",
  canceled: "Annullato",
  refunded: "Rimborsato",
  partially_refunded: "Rimborsato in parte",
  disputed: "In contestazione",
};

/** Ordini da mostrare in «I miei acquisti»: quelli con un esito (non i checkout lasciati a metà). */
export const SHOWN_ORDER_STATUSES = ["completed", "failed", "refunded", "partially_refunded", "disputed"];

// ------------------------------------------------------------------ webhook

/** Eventi che il webhook tratta, e cosa rileggere da Stripe per decidere. Gli altri si registrano come ignorati. */
export type EventTarget = { kind: "session"; id: string } | { kind: "charge"; id: string } | { kind: "dispute"; id: string } | null;

export function eventTarget(event: { type: string; data: { object: { id?: unknown; object?: unknown } } }): EventTarget {
  const id = typeof event.data.object.id === "string" ? event.data.object.id : "";
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired":
      return /^cs_(test|live)_/.test(id) ? { kind: "session", id } : null;
    case "charge.refunded":
      return /^(ch|py)_/.test(id) ? { kind: "charge", id } : null;
    case "charge.dispute.created":
    case "charge.dispute.closed":
      return /^(dp|du)_/.test(id) ? { kind: "dispute", id } : null;
    default:
      return null;
  }
}

export interface SessionState {
  id: string;
  status: string | null;
  payment_status: string;
  client_reference_id: string | null;
  amount_total: number | null;
  currency: string | null;
  payment_intent: string | { id: string } | null;
  customer: string | { id: string } | null;
}

const idOf = (v: string | { id: string } | null) => (v === null ? null : typeof v === "string" ? v : v.id);

export type SessionOutcome =
  | { action: "paid"; order: string; session: string; paymentIntent: string | null; customer: string | null; amount: number | null; currency: string | null }
  | { action: "failed" | "expired"; order: string }
  | { action: "wait"; order: string }
  | { action: "unknown" };

/**
 * Esito di una sessione riletta da Stripe (non dall'evento: gli eventi possono arrivare fuori ordine).
 * Pagata → «paid»; scaduta → «expired»; completata ma non pagata → «failed» solo se l'evento è il fallimento del
 * pagamento asincrono, altrimenti si aspetta (bonifico o altro metodo in elaborazione).
 */
export function sessionOutcome(session: SessionState, eventType: string): SessionOutcome {
  const order = session.client_reference_id ?? "";
  if (!UUID_RE.test(order)) return { action: "unknown" };
  if (session.payment_status === "paid") {
    return {
      action: "paid", order, session: session.id, paymentIntent: idOf(session.payment_intent), customer: idOf(session.customer),
      amount: session.amount_total, currency: session.currency,
    };
  }
  if (session.status === "expired") return { action: "expired", order };
  if (session.status === "complete" && eventType === "checkout.session.async_payment_failed") return { action: "failed", order };
  return { action: "wait", order };
}

/** Contestazione: aperta finché Stripe non la chiude; vinta (o chiusa senza addebito) ripristina, persa revoca. */
export function disputeState(status: string): "open" | "won" | "lost" {
  if (status === "won" || status === "warning_closed" || status === "prevented") return "won";
  if (status === "lost") return "lost";
  return "open";
}
