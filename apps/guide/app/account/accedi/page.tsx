import Link from "next/link";
import { accountSetup } from "../../../lib/account/server";
import { PROVIDER_LABEL, safeNext } from "../../../lib/account/shared";
import { signIn, signInWith } from "../actions";
import { AccountPage, NotAvailable, one, Outcome, type SearchParams } from "../ui";

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const setup = accountSetup();
  if (!setup.ok) return <NotAvailable />;
  const q = await searchParams;
  const next = safeNext(one(q.next));
  return (
    <AccountPage title="Accedi">
      <p className="muted">Serve un account solo per acquistare e ritrovare i tuoi acquisti su altri dispositivi.</p>
      <Outcome ok={one(q.ok)} errore={one(q.errore)} />
      <form action={signIn} className="acc-form">
        <input type="hidden" name="next" value={next} />
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button className="button primary block" type="submit">Accedi</button>
      </form>
      {setup.config.providers.length > 0 && (
        <>
          <div className="acc-sep">oppure</div>
          {setup.config.providers.map((p) => (
            <form key={p} action={signInWith}>
              <input type="hidden" name="provider" value={p} />
              <input type="hidden" name="next" value={next} />
              <button className="button block" type="submit">Continua con {PROVIDER_LABEL[p]}</button>
            </form>
          ))}
        </>
      )}
      <div className="acc-links">
        <Link href="/account/registrati">Crea un account</Link>
        <Link href="/account/password">Password dimenticata?</Link>
      </div>
    </AccountPage>
  );
}
