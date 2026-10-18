import Link from "next/link";
import { accountSetup, requireVisitor } from "../../../lib/account/server";
import { paymentsSetup } from "../../../lib/payments/server";
import { PACK_RE, shopPath } from "../../../lib/payments/shared";
import { formatEuro, PRODUCT_KIND_LABELS } from "../../../lib/studio/catalog";
import { AccountPage, NotAvailable, one, Outcome, type SearchParams } from "../ui";

interface CatalogItem {
  id: string;
  kind: "explore" | "route" | "bundle";
  labels: { it?: { name?: string; description?: string } };
  price: { amount: number; currency: string };
  available: boolean;
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
  const [catalog, purchases, rights] = await Promise.all([
    supabase.rpc("public_catalog", { p_pack: pack }),
    supabase.from("purchases").select("product_id").eq("user_id", user.id).in("status", ["completed", "partially_refunded", "disputed"]),
    supabase.from("entitlements").select("product_id").eq("user_id", user.id).eq("status", "active"),
  ]);
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
          data di scadenza futura e un CVC qualsiasi. I contenuti acquistati si sbloccheranno nell&apos;app con il prossimo
          aggiornamento: per ora l&apos;acquisto resta registrato nel tuo account.
          </span>
        </p>
      ) : (
        <p className="notice" role="status">Gli acquisti non sono ancora attivi.</p>
      )}
      {catalog.error && <p className="notice error" role="alert">Il listino non è disponibile in questo momento.</p>}
      {!catalog.error && items.length === 0 && <p className="muted">Per questa destinazione non ci sono contenuti in vendita.</p>}
      {items.map((item) => {
        const name = item.labels.it?.name ?? "Contenuto";
        return (
          <section key={item.id} className="card flat acc-product">
            <p className="muted small">{PRODUCT_KIND_LABELS[item.kind] ?? item.kind}</p>
            <h2>{name}</h2>
            {item.labels.it?.description && <p className="small">{item.labels.it.description}</p>}
            <p className="acc-price">{formatEuro(item.price.amount)}</p>
            {owned.has(item.id) ? (
              <p className="notice success" role="status">Già acquistato</p>
            ) : !item.available ? (
              <p className="muted small">Al momento non acquistabile.</p>
            ) : payments.ok ? (
              <form action="/api/checkout" method="post">
                <input type="hidden" name="prodotto" value={item.id} />
                <input type="hidden" name="destinazione" value={pack} />
                <button className="button block" type="submit">Acquista · {formatEuro(item.price.amount)}</button>
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
