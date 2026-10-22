/**
 * Checkout e webhook con le dipendenze passate dall'esterno (Stripe, database): così si provano con sostituti
 * (test/payments.test.ts) e le route restano solo collegamento. Vedi docs/v0.3-platform/PAGAMENTI.md.
 */
import { CHECKOUT_MINUTES, checkoutErrorCode, disputeState, eventTarget, orderPath, sessionOutcome, shopPath, UUID_RE, type SessionState } from "./shared";

type RpcResult<T = unknown> = { data: T | null; error: { message: string; code?: string } | null };
export type Rpc = <T = unknown>(fn: string, args: Record<string, unknown>) => Promise<RpcResult<T>>;
type Ref = string | { id: string } | null;
const idOf = (v: Ref) => (v === null ? null : typeof v === "string" ? v : v.id);
const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300);

// ------------------------------------------------------------------ checkout

export interface CheckoutDeps {
  /** Funzioni del database con l'identità dell'utente (checkout_open, checkout_attach, checkout_abandon). */
  rpc: Rpc;
  stripe: {
    createSession(params: CheckoutSessionParams, idempotencyKey: string): Promise<{ id: string; url: string | null }>;
    expireSession(id: string): Promise<void>;
    retrieveSession(id: string): Promise<SessionState>;
  };
  log(entry: Record<string, unknown>): void;
}

export interface CheckoutSessionParams {
  mode: "payment";
  line_items: { quantity: 1; price_data: { currency: "eur"; unit_amount: number; product_data: { name: string } } }[];
  client_reference_id: string;
  metadata: { order: string; user: string };
  customer_email?: string;
  success_url: string;
  cancel_url: string;
  expires_at: number;
  locale: "it";
}

export interface CheckoutRequest {
  productId: string;
  pack: string;
  user: { id: string; email?: string | null };
  origin: string;
  now: number;
}

/** Esito: sempre un indirizzo verso cui mandare il browser (Stripe, oppure la pagina con l'errore). */
export async function startCheckout(req: CheckoutRequest, deps: CheckoutDeps): Promise<{ redirect: string }> {
  const back = (code: string) => ({ redirect: `${shopPath(req.pack)}&errore=${code}` });
  if (!UUID_RE.test(req.productId)) return back("non-in-vendita");

  const opened = await deps.rpc<{ order: string; amount: number; currency: string; name: string; supersede: string[] }>("checkout_open", { p_product: req.productId });
  if (opened.error || !opened.data) return back(checkoutErrorCode(opened.error?.message));
  const { order, amount, name, supersede } = opened.data;
  const abandon = async () => {
    const r = await deps.rpc("checkout_abandon", { p_order: order });
    if (r.error) deps.log({ event: "checkout_abandon_error", order, code: r.error.code });
  };

  // Un solo checkout aperto per prodotto: le sessioni precedenti si fanno scadere. Se una risulta già pagata,
  // non se ne apre un'altra (il webhook la sta per confermare).
  for (const old of supersede ?? []) {
    try {
      await deps.stripe.expireSession(old);
    } catch (e) {
      let state: SessionState | null = null;
      try { state = await deps.stripe.retrieveSession(old); } catch { /* resta null */ }
      if (state?.status === "expired") continue;
      deps.log({ event: "checkout_supersede_error", order, session: old, status: state?.status ?? null, error: short(e) });
      await abandon();
      return back(state?.status === "complete" ? "pagamento-in-corso" : "servizio");
    }
  }

  const params: CheckoutSessionParams = {
    mode: "payment",
    line_items: [{ quantity: 1, price_data: { currency: "eur", unit_amount: amount, product_data: { name } } }],
    client_reference_id: order,
    metadata: { order, user: req.user.id },
    ...(req.user.email ? { customer_email: req.user.email } : {}),
    success_url: `${req.origin}${orderPath(order)}`,
    cancel_url: `${req.origin}${orderPath(order)}&annullato=1`,
    expires_at: Math.floor(req.now / 1000) + CHECKOUT_MINUTES * 60 + 60,
    locale: "it",
  };
  let session: { id: string; url: string | null };
  try {
    session = await deps.stripe.createSession(params, `checkout-${order}`);
  } catch (e) {
    deps.log({ event: "checkout_session_error", order, error: short(e) });
    await abandon();
    return back("servizio");
  }
  const attached = await deps.rpc("checkout_attach", { p_order: order, p_session: session.id });
  if (attached.error || !session.url) {
    deps.log({ event: "checkout_attach_error", order, code: attached.error?.code ?? "url" });
    try { await deps.stripe.expireSession(session.id); } catch { /* scade comunque da sola */ }
    await abandon();
    return back("servizio");
  }
  deps.log({ event: "checkout_started", order, amount });
  return { redirect: session.url };
}

// ------------------------------------------------------------------ webhook

export interface WebhookEvent {
  id: string;
  type: string;
  data: { object: { id?: unknown; object?: unknown } };
}

export interface WebhookDeps {
  /** Verifica la firma sul corpo grezzo; lancia un errore se non è valida. */
  verify(raw: string, signature: string): WebhookEvent;
  retrieveSession(id: string): Promise<SessionState>;
  retrieveCharge(id: string): Promise<{ id: string; amount_refunded: number; payment_intent: Ref }>;
  retrieveDispute(id: string): Promise<{ id: string; status: string; payment_intent: Ref; charge: Ref }>;
  /** Funzioni del database con il ruolo di servizio (payment_*). */
  rpc: Rpc;
  log(entry: Record<string, unknown>): void;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

export async function handleWebhook(raw: string, signature: string | null, deps: WebhookDeps): Promise<WebhookResponse> {
  if (!signature) return { status: 400, body: { error: "firma mancante" } };
  let event: WebhookEvent;
  try {
    event = deps.verify(raw, signature);
  } catch {
    deps.log({ event: "webhook_bad_signature" });
    return { status: 400, body: { error: "firma non valida" } };
  }
  const begun = await deps.rpc<string>("payment_event_begin", { p_event: event.id, p_type: event.type });
  if (begun.error) {
    deps.log({ event: "webhook_db_error", stripeEvent: event.id, code: begun.error.code });
    return { status: 500, body: { error: "database" } };
  }
  if (begun.data === "done") return { status: 200, body: { received: true, duplicate: true } };

  const end = async (status: "processed" | "ignored" | "error", purchase: string | null, error: string | null) => {
    const r = await deps.rpc("payment_event_end", { p_event: event.id, p_status: status, p_purchase: purchase, p_error: error });
    if (r.error) throw new Error(`payment_event_end: ${r.error.message}`);
  };
  const call = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const r = await deps.rpc<T>(fn, args);
    if (r.error) throw new Error(`${fn}: ${r.error.message}`);
    return r.data as T;
  };

  try {
    const target = eventTarget(event);
    if (!target) {
      await end("ignored", null, null);
      return { status: 200, body: { received: true, ignored: true } };
    }
    let order: string | null = null;
    let outcome: Record<string, unknown> = {};
    if (target.kind === "session") {
      const s = sessionOutcome(await deps.retrieveSession(target.id), event.type);
      if (s.action === "unknown") {
        await end("ignored", null, "sessione senza ordine riconoscibile");
        return { status: 200, body: { received: true, ignored: true } };
      }
      order = s.order;
      if (s.action === "paid") {
        outcome = await call<Record<string, unknown>>("payment_paid", {
          p_order: s.order, p_session: s.session, p_payment_intent: s.paymentIntent, p_customer: s.customer,
          p_amount_total: s.amount, p_currency: s.currency,
        });
        if (outcome.problem) deps.log({ event: "webhook_payment_problem", order, problem: outcome.problem });
      } else if (s.action === "failed" || s.action === "expired") {
        outcome = await call<Record<string, unknown>>("payment_unpaid", { p_order: s.order, p_status: s.action });
      } else {
        outcome = { waiting: true };
      }
    } else if (target.kind === "charge") {
      const c = await deps.retrieveCharge(target.id);
      const pi = idOf(c.payment_intent);
      if (!pi) {
        await end("ignored", null, "addebito senza pagamento collegato");
        return { status: 200, body: { received: true, ignored: true } };
      }
      outcome = await call<Record<string, unknown>>("payment_refunded", { p_payment_intent: pi, p_amount_refunded: c.amount_refunded });
      order = typeof outcome.order === "string" ? outcome.order : null;
    } else {
      const d = await deps.retrieveDispute(target.id);
      let pi = idOf(d.payment_intent);
      const charge = idOf(d.charge);
      if (!pi && charge) pi = idOf((await deps.retrieveCharge(charge)).payment_intent);
      if (!pi) {
        await end("ignored", null, "contestazione senza pagamento collegato");
        return { status: 200, body: { received: true, ignored: true } };
      }
      outcome = await call<Record<string, unknown>>("payment_dispute", { p_payment_intent: pi, p_state: disputeState(d.status) });
      order = typeof outcome.order === "string" ? outcome.order : null;
    }
    await end("processed", order, null);
    deps.log({ event: "webhook_processed", stripeEvent: event.id, type: event.type, order, status: outcome.status ?? null, changed: outcome.changed ?? null });
    return { status: 200, body: { received: true } };
  } catch (e) {
    const message = short(e);
    deps.log({ event: "webhook_error", stripeEvent: event.id, type: event.type, error: message });
    try { await end("error", null, message); } catch { /* l'errore principale è già registrato nel log */ }
    // 500: Stripe riprova più tardi; il registro degli eventi riconosce il tentativo e lo ripete.
    return { status: 500, body: { error: "elaborazione non riuscita" } };
  }
}
