import Link from "next/link";
import { accountSetup, requireVisitor } from "../../lib/account/server";
import { PROVIDER_LABEL } from "../../lib/account/shared";
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
        <p className="muted small">Nessun acquisto. Gli acquisti saranno disponibili con il catalogo della guida.</p>
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
