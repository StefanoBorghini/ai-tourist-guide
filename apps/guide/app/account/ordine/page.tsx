import Link from "next/link";
import { accountSetup, requireVisitor } from "../../../lib/account/server";
import { ORDER_STATUS_LABELS, orderPath, shopPath, UUID_RE } from "../../../lib/payments/shared";
import { formatEuro } from "../../../lib/studio/catalog";
import { AccountPage, NotAvailable, one, type SearchParams } from "../ui";
import { AutoRefresh } from "./refresh";

/**
 * Ritorno da Stripe. Mostra lo stato dell'ordine letto dal database e non concede nulla: l'acquisto diventa attivo
 * solo quando il webhook riceve la conferma del pagamento.
 */
export default async function OrderPage({ searchParams }: { searchParams: SearchParams }) {
  if (!accountSetup().ok) return <NotAvailable />;
  const q = await searchParams;
  const id = one(q.id) ?? "";
  const canceled = one(q.annullato) === "1";
  const { supabase, user } = await requireVisitor(UUID_RE.test(id) ? orderPath(id) : "/account");
  const { data: order } = UUID_RE.test(id)
    ? await supabase.from("purchases").select("id, status, unit_amount, product_snapshot, created_at").eq("id", id).eq("user_id", user.id).maybeSingle()
    : { data: null };
  if (!order) {
    return (
      <AccountPage title="Ordine" back={{ href: "/account", label: "Il tuo account" }}>
        <p className="notice" role="status">Ordine non trovato.</p>
      </AccountPage>
    );
  }
  const snapshot = (order.product_snapshot ?? {}) as { pack?: string; labels?: { it?: { name?: string } } };
  const name = snapshot.labels?.it?.name ?? "Contenuto";
  const status = order.status as string;
  const waiting = status === "pending" && !canceled;

  return (
    <AccountPage title="Ordine" back={{ href: "/account", label: "Il tuo account" }}>
      <section className="card flat">
        <p className="muted small">{name}</p>
        <p className="acc-price">{order.unit_amount ? formatEuro(order.unit_amount) : ""}</p>
        {status === "completed" && (
          <>
            <p className="notice success" role="status">Pagamento riuscito: l&apos;acquisto è nel tuo account.</p>
            {/* Caricamento completo (non navigazione interna): la guida riparte e chiede gli acquisti (lib/premium-client.ts). */}
            <a className="button primary block" href="/">Apri nella guida</a>
          </>
        )}
        {waiting && (
          <p className="notice" role="status" aria-live="polite">In attesa della conferma del pagamento… La pagina si aggiorna da sola.</p>
        )}
        {status === "pending" && canceled && <p className="notice" role="status">Pagamento annullato: non ti è stato addebitato nulla.</p>}
        {!["completed", "pending"].includes(status) && <p className="notice" role="status">{ORDER_STATUS_LABELS[status] ?? status}.</p>}
      </section>
      {waiting && <AutoRefresh />}
      <div className="acc-links">
        <Link href="/account">I miei acquisti</Link>
        {snapshot.pack && <Link href={shopPath(snapshot.pack)}>Contenuti in vendita</Link>}
      </div>
    </AccountPage>
  );
}
