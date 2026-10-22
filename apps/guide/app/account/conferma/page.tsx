import Link from "next/link";
import { accountSetup } from "../../../lib/account/server";
import { resendConfirmation } from "../actions";
import { AccountPage, NotAvailable, one, Outcome, type SearchParams } from "../ui";

/**
 * Dopo la registrazione (o un accesso con l'indirizzo non ancora confermato): cosa fare con l'email di conferma e
 * «Non è arrivata?» per riceverne una nuova. L'indirizzo non passa nell'URL: lo si riscrive.
 */
export default async function ConfirmEmailPage({ searchParams }: { searchParams: SearchParams }) {
  const setup = accountSetup();
  if (!setup.ok) return <NotAvailable />;
  const q = await searchParams;
  return (
    <AccountPage title="Conferma l'indirizzo" back={{ href: "/account/accedi", label: "Accedi" }}>
      <Outcome ok={one(q.ok)} errore={one(q.errore)} />
      <ol className="acc-steps">
        <li>Apri l&apos;email che ti abbiamo inviato e tocca il link di conferma.</li>
        <li>Si apre la guida con l&apos;account già attivo: da lì puoi acquistare.</li>
      </ol>
      <p className="muted small">
        Non la trovi? Guarda anche in «Spam» o «Promozioni»; può volerci qualche minuto. Il link vale per poco tempo: se è
        scaduto, chiedine uno nuovo qui sotto.
      </p>
      <h2 className="acc-subtitle">Non è arrivata?</h2>
      <form action={resendConfirmation} className="acc-form">
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <button className="button block" type="submit">Invia di nuovo l&apos;email</button>
      </form>
      <div className="acc-links">
        <Link href="/account/accedi">Hai già confermato? Accedi</Link>
        <Link href="/account/registrati">Hai sbagliato indirizzo? Registrati di nuovo</Link>
      </div>
    </AccountPage>
  );
}
