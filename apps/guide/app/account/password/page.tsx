import { accountSetup } from "../../../lib/account/server";
import { requestPasswordReset } from "../actions";
import { AccountPage, NotAvailable, one, Outcome, type SearchParams } from "../ui";

export default async function ForgotPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  if (!accountSetup().ok) return <NotAvailable />;
  const q = await searchParams;
  return (
    <AccountPage title="Password dimenticata" back={{ href: "/account/accedi", label: "Accedi" }}>
      <p className="muted">Scrivi l'indirizzo dell'account: ti invieremo un link per sceglierne una nuova.</p>
      <Outcome errore={one(q.errore)} />
      <form action={requestPasswordReset} className="acc-form">
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <button className="button primary block" type="submit">Invia il link</button>
      </form>
    </AccountPage>
  );
}
