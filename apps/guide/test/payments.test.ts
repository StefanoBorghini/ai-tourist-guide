import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { handleWebhook, startCheckout, type CheckoutDeps, type Rpc, type WebhookDeps } from "../lib/payments/flows.ts";
import { checkoutErrorCode, disputeState, eventTarget, readPaymentsConfig, sessionOutcome, type SessionState } from "../lib/payments/shared.ts";

const ORDER = "11111111-2222-4333-8444-555555555555";
const PRODUCT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SECRET = "whsec_provalocale12345678";

describe("configurazione: solo modalità test", () => {
  const ok = { STRIPE_SECRET_KEY: "sk_test_abcdefgh1234", STRIPE_WEBHOOK_SECRET: SECRET, SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40) };
  it("chiavi di test e chiave di servizio", () => {
    expect(readPaymentsConfig(ok).ok).toBe(true);
  });
  it("una chiave live spegne gli acquisti", () => {
    const r = readPaymentsConfig({ ...ok, STRIPE_SECRET_KEY: "sk_live_abcdefgh1234" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.missing.join()).toMatch(/live non sono ammesse/);
    expect(readPaymentsConfig({ ...ok, STRIPE_SECRET_KEY: "rk_live_abcdefgh1234" }).ok).toBe(false);
  });
  it("mancano segreto del webhook o chiave di servizio", () => {
    expect(readPaymentsConfig({ ...ok, STRIPE_WEBHOOK_SECRET: "" }).ok).toBe(false);
    expect(readPaymentsConfig({ ...ok, SUPABASE_SERVICE_ROLE_KEY: undefined }).ok).toBe(false);
  });
  it("sostituto di Stripe solo su localhost", () => {
    const r = readPaymentsConfig({ ...ok, STRIPE_API_BASE: "http://localhost:12111" });
    expect(r.ok && r.config.apiBase).toEqual({ protocol: "http", host: "localhost", port: 12111 });
    expect(readPaymentsConfig({ ...ok, STRIPE_API_BASE: "https://example.com:443" }).ok).toBe(false);
  });
});

describe("regole pure", () => {
  it("errori del database → codici, mai il testo", () => {
    expect(checkoutErrorCode("hai già acquistato questo contenuto")).toBe("gia-acquistato");
    expect(checkoutErrorCode("prodotto esaurito")).toBe("esaurito");
    expect(checkoutErrorCode("destinazione non ancora pubblicata")).toBe("non-pubblicata");
    expect(checkoutErrorCode("prodotto senza prezzo pubblicato")).toBe("non-in-vendita");
    expect(checkoutErrorCode("errore qualsiasi")).toBe("servizio");
  });
  it("eventi trattati e ignorati", () => {
    expect(eventTarget({ type: "checkout.session.completed", data: { object: { id: "cs_test_1" } } })).toEqual({ kind: "session", id: "cs_test_1" });
    expect(eventTarget({ type: "charge.refunded", data: { object: { id: "ch_1" } } })).toEqual({ kind: "charge", id: "ch_1" });
    expect(eventTarget({ type: "charge.dispute.closed", data: { object: { id: "dp_1" } } })).toEqual({ kind: "dispute", id: "dp_1" });
    expect(eventTarget({ type: "customer.created", data: { object: { id: "cus_1" } } })).toBeNull();
    expect(eventTarget({ type: "checkout.session.completed", data: { object: { id: "altro" } } })).toBeNull();
  });
  const session = (over: Partial<SessionState>): SessionState => ({
    id: "cs_test_1", status: "complete", payment_status: "paid", client_reference_id: ORDER, amount_total: 499, currency: "eur",
    payment_intent: "pi_1", customer: null, ...over,
  });
  it("esito della sessione riletta da Stripe", () => {
    expect(sessionOutcome(session({}), "checkout.session.completed")).toMatchObject({ action: "paid", order: ORDER, paymentIntent: "pi_1", amount: 499 });
    expect(sessionOutcome(session({ payment_status: "unpaid" }), "checkout.session.completed").action).toBe("wait");
    expect(sessionOutcome(session({ payment_status: "unpaid" }), "checkout.session.async_payment_failed").action).toBe("failed");
    expect(sessionOutcome(session({ status: "expired", payment_status: "unpaid" }), "checkout.session.expired").action).toBe("expired");
    // L'evento dice «scaduta» ma Stripe dice «pagata» (fuori ordine): vale Stripe.
    expect(sessionOutcome(session({}), "checkout.session.expired").action).toBe("paid");
    expect(sessionOutcome(session({ client_reference_id: "non-un-ordine" }), "checkout.session.completed").action).toBe("unknown");
  });
  it("contestazioni", () => {
    expect(disputeState("needs_response")).toBe("open");
    expect(disputeState("under_review")).toBe("open");
    expect(disputeState("won")).toBe("won");
    expect(disputeState("warning_closed")).toBe("won");
    expect(disputeState("lost")).toBe("lost");
  });
});

// ------------------------------------------------------------------ checkout con dipendenze finte

function checkoutFake(opts: { open?: { data?: unknown; error?: { message: string } }; supersede?: string[]; expireFails?: string; oldStatus?: string; createFails?: boolean } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const created: { params: unknown; key: string }[] = [];
  const expired: string[] = [];
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === "checkout_open") {
      return (opts.open ?? { data: { order: ORDER, amount: 499, currency: "EUR", name: "Esplorazione", supersede: opts.supersede ?? [] } }) as never;
    }
    return { data: null, error: null };
  };
  const deps: CheckoutDeps = {
    rpc,
    stripe: {
      createSession: async (params, key) => {
        if (opts.createFails) throw new Error("rete");
        created.push({ params, key });
        return { id: "cs_test_nuova", url: "https://checkout.stripe.com/c/pay/cs_test_nuova" };
      },
      expireSession: async (id) => {
        if (id === opts.expireFails) throw new Error("già conclusa");
        expired.push(id);
      },
      retrieveSession: async (id) => ({ id, status: opts.oldStatus ?? "complete", payment_status: "paid", client_reference_id: ORDER, amount_total: 499, currency: "eur", payment_intent: null, customer: null }),
    },
    log: () => {},
  };
  return { deps, calls, created, expired };
}
const req = { productId: PRODUCT, pack: "it.test.borgo", user: { id: "u1", email: "a@b.it" }, origin: "https://guida.example", now: 1_800_000_000_000 };

describe("checkout", () => {
  it("il browser manda solo il prodotto: importo e ordine dal database, chiave di idempotenza = ordine", async () => {
    const f = checkoutFake();
    const r = await startCheckout(req, f.deps);
    expect(r.redirect).toBe("https://checkout.stripe.com/c/pay/cs_test_nuova");
    expect(f.created).toHaveLength(1);
    expect(f.created[0]!.key).toBe(`checkout-${ORDER}`);
    expect(f.created[0]!.params).toMatchObject({
      mode: "payment", client_reference_id: ORDER, metadata: { order: ORDER, user: "u1" },
      line_items: [{ quantity: 1, price_data: { currency: "eur", unit_amount: 499 } }],
      success_url: `https://guida.example/account/ordine?id=${ORDER}`,
      cancel_url: `https://guida.example/account/ordine?id=${ORDER}&annullato=1`,
    });
    expect(f.calls.map((c) => c.fn)).toEqual(["checkout_open", "checkout_attach"]);
    expect(f.calls[1]!.args).toEqual({ p_order: ORDER, p_session: "cs_test_nuova" });
  });
  it("id del prodotto non valido: nessuna chiamata", async () => {
    const f = checkoutFake();
    const r = await startCheckout({ ...req, productId: "1; drop" }, f.deps);
    expect(r.redirect).toContain("errore=non-in-vendita");
    expect(f.calls).toHaveLength(0);
  });
  it("errore del database → codice nella pagina d'acquisto", async () => {
    const f = checkoutFake({ open: { data: null, error: { message: "hai già acquistato questo contenuto" } } });
    const r = await startCheckout(req, f.deps);
    expect(r.redirect).toBe("/account/acquista?destinazione=it.test.borgo&errore=gia-acquistato");
    expect(f.created).toHaveLength(0);
  });
  it("le sessioni precedenti si fanno scadere prima di aprirne una nuova", async () => {
    const f = checkoutFake({ supersede: ["cs_test_vecchia"] });
    await startCheckout(req, f.deps);
    expect(f.expired).toEqual(["cs_test_vecchia"]);
    expect(f.created).toHaveLength(1);
  });
  it("sessione precedente già pagata: nessun nuovo checkout, ordine nuovo chiuso", async () => {
    const f = checkoutFake({ supersede: ["cs_test_pagata"], expireFails: "cs_test_pagata", oldStatus: "complete" });
    const r = await startCheckout(req, f.deps);
    expect(r.redirect).toContain("errore=pagamento-in-corso");
    expect(f.created).toHaveLength(0);
    expect(f.calls.map((c) => c.fn)).toEqual(["checkout_open", "checkout_abandon"]);
  });
  it("Stripe non risponde: ordine chiuso, messaggio di servizio", async () => {
    const f = checkoutFake({ createFails: true });
    const r = await startCheckout(req, f.deps);
    expect(r.redirect).toContain("errore=servizio");
    expect(f.calls.map((c) => c.fn)).toEqual(["checkout_open", "checkout_abandon"]);
  });
});

// ------------------------------------------------------------------ webhook con firma vera e database finto

const signed = (event: object) => {
  const payload = JSON.stringify(event);
  return { payload, signature: Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }) };
};

function webhookFake(opts: { begin?: string; session?: Partial<SessionState>; rpcError?: string; amountRefunded?: number; dispute?: string } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === "payment_event_begin") return { data: (opts.begin ?? "new") as never, error: null };
    if (opts.rpcError === fn) return { data: null, error: { message: "boom" } };
    if (fn === "payment_paid") return { data: { order: args.p_order, status: "completed", changed: true } as never, error: null };
    return { data: { order: ORDER, status: "x", changed: true } as never, error: null };
  };
  const deps: WebhookDeps = {
    verify: (raw, sig) => Stripe.webhooks.constructEvent(raw, sig, SECRET) as never,
    retrieveSession: async (id) => ({ id, status: "complete", payment_status: "paid", client_reference_id: ORDER, amount_total: 499, currency: "eur", payment_intent: "pi_1", customer: "cus_1", ...opts.session }),
    retrieveCharge: async (id) => ({ id, amount_refunded: opts.amountRefunded ?? 499, payment_intent: "pi_1" }),
    retrieveDispute: async (id) => ({ id, status: opts.dispute ?? "needs_response", payment_intent: null, charge: "ch_1" }),
    rpc,
    log: () => {},
  };
  return { deps, calls };
}
const completed = { id: "evt_test_1", type: "checkout.session.completed", data: { object: { id: "cs_test_1", object: "checkout.session" } } };

describe("webhook", () => {
  it("firma mancante o non valida: 400 e nessun effetto", async () => {
    const f = webhookFake();
    const { payload } = signed(completed);
    expect((await handleWebhook(payload, null, f.deps)).status).toBe(400);
    const bad = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_altrosegreto123456" });
    expect((await handleWebhook(payload, bad, f.deps)).status).toBe(400);
    // Corpo alterato dopo la firma.
    const { signature } = signed(completed);
    expect((await handleWebhook(payload.replace("cs_test_1", "cs_test_2"), signature, f.deps)).status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });
  it("pagamento: stato riletto da Stripe e applicato una volta", async () => {
    const f = webhookFake();
    const { payload, signature } = signed(completed);
    const r = await handleWebhook(payload, signature, f.deps);
    expect(r.status).toBe(200);
    expect(f.calls.map((c) => c.fn)).toEqual(["payment_event_begin", "payment_paid", "payment_event_end"]);
    expect(f.calls[1]!.args).toEqual({ p_order: ORDER, p_session: "cs_test_1", p_payment_intent: "pi_1", p_customer: "cus_1", p_amount_total: 499, p_currency: "eur" });
    expect(f.calls[2]!.args).toMatchObject({ p_status: "processed", p_purchase: ORDER });
  });
  it("evento già applicato: 200 senza rifare nulla", async () => {
    const f = webhookFake({ begin: "done" });
    const { payload, signature } = signed(completed);
    const r = await handleWebhook(payload, signature, f.deps);
    expect(r).toEqual({ status: 200, body: { received: true, duplicate: true } });
    expect(f.calls.map((c) => c.fn)).toEqual(["payment_event_begin"]);
  });
  it("sessione scaduta e pagamento asincrono fallito", async () => {
    const f = webhookFake({ session: { status: "expired", payment_status: "unpaid" } });
    const e = signed({ ...completed, type: "checkout.session.expired" });
    await handleWebhook(e.payload, e.signature, f.deps);
    expect(f.calls[1]).toEqual({ fn: "payment_unpaid", args: { p_order: ORDER, p_status: "expired" } });
    const g = webhookFake({ session: { payment_status: "unpaid" } });
    const e2 = signed({ ...completed, type: "checkout.session.async_payment_failed" });
    await handleWebhook(e2.payload, e2.signature, g.deps);
    expect(g.calls[1]).toEqual({ fn: "payment_unpaid", args: { p_order: ORDER, p_status: "failed" } });
  });
  it("pagamento asincrono in corso: nessun esito, evento registrato", async () => {
    const f = webhookFake({ session: { payment_status: "unpaid" } });
    const { payload, signature } = signed(completed);
    expect((await handleWebhook(payload, signature, f.deps)).status).toBe(200);
    expect(f.calls.map((c) => c.fn)).toEqual(["payment_event_begin", "payment_event_end"]);
  });
  it("rimborso e contestazione", async () => {
    const f = webhookFake({ amountRefunded: 200 });
    const e = signed({ id: "evt_test_2", type: "charge.refunded", data: { object: { id: "ch_1", object: "charge" } } });
    await handleWebhook(e.payload, e.signature, f.deps);
    expect(f.calls[1]).toEqual({ fn: "payment_refunded", args: { p_payment_intent: "pi_1", p_amount_refunded: 200 } });
    const g = webhookFake({ dispute: "lost" });
    const d = signed({ id: "evt_test_3", type: "charge.dispute.closed", data: { object: { id: "dp_1", object: "dispute" } } });
    await handleWebhook(d.payload, d.signature, g.deps);
    expect(g.calls[1]).toEqual({ fn: "payment_dispute", args: { p_payment_intent: "pi_1", p_state: "lost" } });
  });
  it("evento non trattato: registrato come ignorato", async () => {
    const f = webhookFake();
    const e = signed({ id: "evt_test_4", type: "customer.created", data: { object: { id: "cus_1" } } });
    expect((await handleWebhook(e.payload, e.signature, f.deps)).status).toBe(200);
    expect(f.calls[1]).toMatchObject({ fn: "payment_event_end", args: { p_status: "ignored" } });
  });
  it("errore del database: 500 (Stripe riprova) ed evento segnato in errore", async () => {
    const f = webhookFake({ rpcError: "payment_paid" });
    const { payload, signature } = signed(completed);
    expect((await handleWebhook(payload, signature, f.deps)).status).toBe(500);
    expect(f.calls.at(-1)).toMatchObject({ fn: "payment_event_end", args: { p_status: "error" } });
  });
});
