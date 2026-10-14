import type { Metadata } from "next";
import { requireVisitor } from "../../../lib/account/server";
import { PASSWORD_MIN } from "../../../lib/account/shared";
import { updatePassword } from "../../account/actions";
import { AccountPage, one, Outcome, type SearchParams } from "../../account/ui";

export const metadata: Metadata = { title: "Nuova password · AI Guide", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Ci si arriva dal link di recupero (/auth/confirm apre la sessione), oppure dal profilo per cambiare password. */
export default async function ResetPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  const { user } = await requireVisitor("/auth/reimposta");
  const q = await searchParams;
  return (
    <AccountPage title="Nuova password" back={{ href: "/account", label: "Account" }}>
      <p className="muted">Account: {user.email}</p>
      <Outcome errore={one(q.errore)} />
      <form action={updatePassword} className="acc-form">
        <label>
          Nuova password (almeno {PASSWORD_MIN} caratteri)
          <input name="password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} required />
        </label>
        <label>
          Ripeti la password
          <input name="confirm" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} required />
        </label>
        <button className="button primary block" type="submit">Salva la password</button>
      </form>
    </AccountPage>
  );
}
