import { signOut } from "../actions";

export default function AccessDenied() {
  return (
    <main className="st-narrow">
      <h1>Accesso non consentito</h1>
      <p className="st-lead">
        Il tuo account non ha un ruolo nello Studio. Chiedi all'amministratore di assegnartene uno per il territorio su cui lavori.
      </p>
      <form action={signOut}>
        <button className="st-btn" type="submit">Esci</button>
      </form>
    </main>
  );
}
