import Link from "next/link";
import { accountSetup, requireVisitor } from "../../../lib/account/server";
import { paymentsSetup } from "../../../lib/payments/server";
import { PACK_RE, shopPath } from "../../../lib/payments/shared";
import { formatEuro, PRODUCT_KIND_LABELS } from "../../../lib/studio/catalog";
import { AccountPage, NotAvailable, one, Outcome, type SearchParams } from "../ui";

interface CatalogItem {
  id: string;
  kind: "explore" | "route" | "bundle" | "place" | "unit" | "all";
  labels: { it?: { name?: string; description?: string } };
  price: { amount: number; currency: string };
  available: boolean;
}

/** Preventivo personale (my_commerce_quotes, migrazione 20261107000000): prezzo con lo sconto per ciò che si ha già. */
interface Quote {
  product: string;
  status: "ok" | "unpriced" | "owned" | "complete" | "below_minimum";
  list: number | null;
  amount: number | null;
  total: number;
  owned: number;
}

/**
 * Contenuti in vendita di una destinazione (listino pubblico, public_catalog) con il pulsante d'acquisto. Il modulo
 * invia solo l'id del prodotto a /api/checkout: prezzo e importo li decide il server.
 */
export default async function ShopPage({ searchParams }: { searchParams: SearchParams }) {
  if (!accountSetup().ok) return <NotAvailable />;
  const q = await searchParams;
  const pack = one(q.destinazione) ?? "";
  const { supabase, user } = await requireVisitor(PACK_RE.test(pack) ? shopPath(pack, one(q.prodotto)) : "/account");
  if (!PACK_RE.test(pack)) {
    return (
      <AccountPage title="Contenuti in vendita" back={{ href: "/account", label: "Il tuo account" }}>
        <p className="notice" role="status">Destinazione non indicata.</p>
      </AccountPage>
    );
  }
  const payments = paymentsSetup();
  const [catalog, purchases, rights, mine] = await Promise.all([
    supabase.rpc("public_catalog", { p_pack: pack }),
    supabase.from("purchases").select("product_id").eq("user_id", user.id).in("status", ["completed", "partially_refunded", "disputed"]),
    supabase.from("entitlements").select("product_id").eq("user_id", user.id).eq("status", "active"),
    supabase.rpc("my_commerce_quotes", { p_pack: pack }),
  ]);
  const quotes = new Map(((mine.data?.quotes ?? []) as Quote[]).map((x) => [x.product, x]));
  const all = (catalog.data ?? []) as CatalogItem[];
  // Arrivo dall'app con un contenuto scelto: si mostra solo quello.
  const focus = one(q.prodotto);
  const items = focus && all.some((i) => i.id === focus) ? all.filter((i) => i.id === focus) : all;
  const owned = new Set([...(purchases.data ?? []), ...(rights.data ?? [])].map((r) => r.product_id as string));

  return (
    <AccountPage title="Contenuti in vendita" back={{ href: "/account", label: "Il tuo account" }}>
      <Outcome errore={one(q.errore)} />
      {payments.ok ? (
        <p className="notice" role="note">
          <span>
          <strong>Modalità di prova:</strong> nessun addebito reale. Per pagare usa la carta di prova 4242 4242 4242 4242, una
          data di scadenza futura e un CVC qualsiasi. I contenuti acquistati si sbloccano nella guida appena torni
          all&apos;app.
          </span>
        </p>
      ) : (
        <p className="notice" role="status">Gli acquisti non sono ancora attivi.</p>
      )}
      {catalog.error && <p className="notice error" role="alert">Il listino non è disponibile in questo momento.</p>}
      {!catalog.error && items.length === 0 && <p className="muted">Per questa destinazione non ci sono contenuti in vendita.</p>}
      {items.map((item) => {
        const name = item.labels.it?.name ?? "Contenuto";
        const quote = quotes.get(item.id);
        // Il prezzo per questo utente (con lo sconto): lo stesso che il server addebiterà al checkout.
        const amount = quote?.amount ?? item.price.amount;
        // Prezzo barrato solo con qualcosa già posseduto (come nella guida, lib/shop.ts).
        const discounted = quote?.status === "ok" && quote.amount !== null && quote.owned > 0
          && quote.amount < (quote.list ?? item.price.amount);
        return (
          <section key={item.id} className="card flat acc-product">
            <p className="muted small">{PRODUCT_KIND_LABELS[item.kind] ?? item.kind}</p>
            <h2>{name}</h2>
            {item.labels.it?.description && <p className="small">{item.labels.it.description}</p>}
            {discounted ? (
              <p className="acc-price">
                <span className="muted small">Hai già {quote!.owned} contenut{quote!.owned === 1 ? "o" : "i"} su {quote!.total}. Prezzo originale </span>
                <s className="muted small">{formatEuro(quote!.list ?? item.price.amount)}</s>
                <span className="muted small"> · il tuo prezzo </span>{formatEuro(amount)}
              </p>
            ) : (
              <p className="acc-price">{formatEuro(item.price.amount)}</p>
            )}
            {owned.has(item.id) || quote?.status === "owned" ? (
              <p className="notice success" role="status">Già acquistato</p>
            ) : quote?.status === "complete" ? (
              <p className="notice success" role="status">Hai già tutti i contenuti compresi.</p>
            ) : quote?.status === "below_minimum" ? (
              <p className="muted small">
                Il resto costerebbe {formatEuro(amount)}, meno del minimo di un pagamento (0,50 €): acquista i contenuti
                che mancano uno per uno.
              </p>
            ) : !item.available ? (
              <p className="muted small">Al momento non acquistabile.</p>
            ) : payments.ok ? (
              <form action="/api/checkout" method="post">
                <input type="hidden" name="prodotto" value={item.id} />
                <input type="hidden" name="destinazione" value={pack} />
                <button className="button block" type="submit">Acquista · {formatEuro(amount)}</button>
              </form>
            ) : null}
          </section>
        );
      })}
      <div className="acc-links">
        {items.length < all.length && <Link href={shopPath(pack)}>Tutti i contenuti in vendita</Link>}
        <Link href="/">Torna alla guida</Link>
        <Link href="/account">I miei acquisti</Link>
      </div>
    </AccountPage>
  );
}
