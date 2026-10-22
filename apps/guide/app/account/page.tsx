import Link from "next/link";
import { accountSetup, requireVisitor } from "../../lib/account/server";
import { PROVIDER_LABEL } from "../../lib/account/shared";
import { ORDER_STATUS_LABELS, orderPath, SHOWN_ORDER_STATUSES, shopPath } from "../../lib/payments/shared";
import { formatEuro } from "../../lib/studio/catalog";
import { linkProvider, signOut, updateProfile } from "./actions";
import { AccountPage, NotAvailable, one, Outcome, type SearchParams } from "./ui";

const METHOD: Record<string, string> = { email: "Email e password", google: "Google", apple: "Apple" };

export default async function AccountHome({ searchParams }: { searchParams: SearchParams }) {
  if (!accountSetup().ok) return <NotAvailable />;
  const { supabase, user, config } = await requireVisitor("/account");
  const q = await searchParams;
  const { data: profile } = await supabase.from("profiles").select("display_name, preferred_locale").eq("user_id", user.id).maybeSingle();
  const methods = [...new Set((user.identities ?? []).map((i) => i.provider))];
  const linkable = config.providers.filter((p) => !methods.includes(p));
  const [{ data: orderRows }, { data: productRows }] = await Promise.all([
    supabase.from("purchases").select("id, status, unit_amount, product_snapshot, created_at").eq("user_id", user.id)
      .in("status", SHOWN_ORDER_STATUSES).order("created_at", { ascending: false }).limit(50),
    // Prodotti in vendita (la policy mostra solo quelli attivi): un collegamento al listino di ogni destinazione.
    supabase.from("products").select("pack_id, labels, kind").eq("status", "active").order("kind").limit(100),
  ]);
  const orders = (orderRows ?? []) as { id: string; status: string; unit_amount: number | null; product_snapshot: { labels?: { it?: { name?: string } } } | null }[];
  // Una voce per destinazione, con il nome dell'esplorazione se c'è.
  const shopMap = new Map<string, { pack: string; name: string }>();
  for (const p of productRows ?? []) {
    const name = p.kind === "explore" ? (p.labels as { it?: { name?: string } })?.it?.name : undefined;
    const prev = shopMap.get(p.pack_id as string);
    if (!prev || (name && prev.name === prev.pack)) shopMap.set(p.pack_id as string, { pack: p.pack_id as string, name: name ?? (p.pack_id as string) });
  }
  const shops = [...shopMap.values()];

  return (
    <AccountPage title="Il tuo account">
      <Outcome ok={one(q.ok)} errore={one(q.errore)} />

      <section className="card flat">
        <h2>Profilo</h2>
        <p className="muted small">{user.email}</p>
        <form action={updateProfile} className="acc-form">
          <label>
            Nome (facoltativo)
            <input name="display_name" type="text" maxLength={80} defaultValue={profile?.display_name ?? ""} autoComplete="nickname" />
          </label>
          <label>
            Lingua
            <select name="locale" defaultValue={profile?.preferred_locale === "en" ? "en" : "it"}>
              <option value="it">Italiano</option>
              <option value="en">English</option>
            </select>
          </label>
          <button className="button block" type="submit">Salva</button>
        </form>
      </section>

      <section className="card flat">
        <h2>I miei acquisti</h2>
        {orders.length === 0 && <p className="muted small">Nessun acquisto.</p>}
        {orders.length > 0 && (
          <ul className="acc-orders small">
            {orders.map((o) => (
              <li key={o.id}>
                <Link href={orderPath(o.id)}>{o.product_snapshot?.labels?.it?.name ?? "Contenuto"}</Link>
                <span className="muted">
                  {o.unit_amount ? formatEuro(o.unit_amount) : ""} · {ORDER_STATUS_LABELS[o.status] ?? o.status}
                </span>
              </li>
            ))}
          </ul>
        )}
        {shops.length > 0 && (
          <div className="acc-links">
            {shops.map((s) => (
              <Link key={s.pack} href={shopPath(s.pack)}>
                Contenuti in vendita: {s.name}
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="card flat">
        <h2>Metodi di accesso</h2>
        <ul className="acc-list small">
          {methods.map((m) => (
            <li key={m}>✓ {METHOD[m] ?? m}</li>
          ))}
        </ul>
        {linkable.map((p) => (
          <form key={p} action={linkProvider}>
            <input type="hidden" name="provider" value={p} />
            <button className="button block" type="submit">Collega {PROVIDER_LABEL[p]}</button>
          </form>
        ))}
        <div className="acc-links">
          <Link href="/auth/reimposta">Cambia password</Link>
        </div>
      </section>

      <section className="card flat">
        <h2>Dati e sessioni</h2>
        <div className="acc-links">
          <a href="/account/esporta" download>Scarica i tuoi dati</a>
        </div>
        <div className="acc-row">
          <form action={signOut}>
            <button className="button" type="submit">Esci</button>
          </form>
          <form action={signOut}>
            <input type="hidden" name="scope" value="global" />
            <button className="button quiet" type="submit">Esci da tutti i dispositivi</button>
          </form>
        </div>
      </section>

      <div className="acc-links">
        <Link href="/account/elimina">Elimina l'account</Link>
      </div>
    </AccountPage>
  );
}
