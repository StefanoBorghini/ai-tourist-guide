import { studioConfig } from "../../../lib/studio/server";
import { signIn } from "../actions";
import { Notice, one, type SearchParams } from "../ui";

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await searchParams;
  const configured = studioConfig() !== null;
  return (
    <main className="st-narrow">
      <h1>Studio</h1>
      <p className="st-lead">Area riservata alla redazione dei territori.</p>
      {!configured ? (
        <p className="st-notice st-error" role="alert">
          Studio non configurato in questo ambiente: mancano <code>NEXT_PUBLIC_SUPABASE_URL</code> e{" "}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>. La guida turistica funziona comunque.
        </p>
      ) : (
        <>
          <Notice errore={one(q.errore) === "sessione" ? "La sessione non è valida: accedi di nuovo." : one(q.errore)} />
          <form action={signIn} className="st-form">
            <label>
              Email
              <input name="email" type="email" autoComplete="username" required />
            </label>
            <label>
              Password
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <button className="st-btn st-primary" type="submit">Accedi</button>
          </form>
          <p className="st-hint">L'accesso allo Studio lo abilita l'amministratore: un account visitatore della guida non basta.</p>
        </>
      )}
    </main>
  );
}
