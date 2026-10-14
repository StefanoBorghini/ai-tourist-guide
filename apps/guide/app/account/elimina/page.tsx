import { requireVisitor } from "../../../lib/account/server";
import { DELETE_CONFIRMATION } from "../../../lib/account/shared";
import { deleteAccount } from "../actions";
import { AccountPage, one, Outcome, type SearchParams } from "../ui";

export default async function DeleteAccountPage({ searchParams }: { searchParams: SearchParams }) {
  const { user } = await requireVisitor("/account/elimina");
  const q = await searchParams;
  return (
    <AccountPage title="Elimina l'account" back={{ href: "/account", label: "Account" }}>
      <Outcome errore={one(q.errore)} />
      <section className="card flat danger">
        <p>
          Stai per eliminare l'account <strong>{user.email}</strong>. Si cancellano profilo, preferenze, consensi e i diritti di
          accesso ai contenuti acquistati: non potrai più ritrovarli con un nuovo account.
        </p>
        <p className="muted small">
          Gli ordini restano conservati per gli obblighi fiscali, senza collegamento a te. L'operazione non si può annullare.
          Prima, se vuoi, scarica i tuoi dati dal profilo.
        </p>
        <form action={deleteAccount} className="acc-form">
          <label>
            Per confermare scrivi {DELETE_CONFIRMATION}
            <input name="confirm" type="text" autoComplete="off" autoCapitalize="characters" required />
          </label>
          <button className="button danger block" type="submit">Elimina definitivamente</button>
        </form>
      </section>
    </AccountPage>
  );
}
