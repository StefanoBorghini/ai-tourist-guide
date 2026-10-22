import Link from "next/link";
import { accountSetup } from "../../../lib/account/server";
import { PASSWORD_MIN } from "../../../lib/account/shared";
import { signUp } from "../actions";
import { AccountPage, NotAvailable, one, Outcome, type SearchParams } from "../ui";

export default async function SignUpPage({ searchParams }: { searchParams: SearchParams }) {
  const setup = accountSetup();
  if (!setup.ok) return <NotAvailable />;
  const q = await searchParams;
  const { legal } = setup.config;
  return (
    <AccountPage title="Crea un account" back={{ href: "/account/accedi", label: "Accedi" }}>
      <p className="muted">Ti invieremo un'email per confermare l'indirizzo. Nessun dato di pagamento viene salvato qui.</p>
      <Outcome errore={one(q.errore)} />
      <form action={signUp} className="acc-form">
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password (almeno {PASSWORD_MIN} caratteri)
          <input name="password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} required />
        </label>
        <label>
          Ripeti la password
          <input name="confirm" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} required />
        </label>
        <label>
          Lingua
          <select name="locale" defaultValue="it">
            <option value="it">Italiano</option>
            <option value="en">English</option>
          </select>
        </label>
        <label className="acc-check">
          <input type="checkbox" name="terms" required />
          <span>
            Accetto le <a href={legal.termsUrl} target="_blank" rel="noopener">condizioni d'uso</a>
          </span>
        </label>
        <label className="acc-check">
          <input type="checkbox" name="privacy" required />
          <span>
            Ho letto l'<a href={legal.privacyUrl} target="_blank" rel="noopener">informativa sulla privacy</a>
          </span>
        </label>
        <button className="button primary block" type="submit">Crea l'account</button>
      </form>
      <div className="acc-links">
        <Link href="/account/accedi">Hai già un account? Accedi</Link>
      </div>
    </AccountPage>
  );
}
