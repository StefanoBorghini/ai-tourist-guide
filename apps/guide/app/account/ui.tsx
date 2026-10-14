/** Elementi comuni delle pagine dell'account. */
import Link from "next/link";
import type { ReactNode } from "react";
import { errorText, messageText } from "../../lib/account/shared";
import "./account.css";

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function AccountPage({ title, children, back = { href: "/", label: "Torna alla guida" } }: { title: string; children: ReactNode; back?: { href: string; label: string } }) {
  return (
    <main className="acc">
      <div className="acc-top">
        <Link href={back.href}>← {back.label}</Link>
        <span className="muted small">AI Guide</span>
      </div>
      <h1>{title}</h1>
      {children}
    </main>
  );
}

/** Esito o errore dai codici nell'indirizzo: solo testi noti (lib/account/shared.ts). */
export function Outcome({ ok, errore }: { ok?: string; errore?: string }) {
  const good = messageText(ok);
  const bad = errorText(errore);
  return (
    <>
      {good && <p className="notice success" role="status">{good}</p>}
      {bad && <p className="notice error" role="alert">{bad}</p>}
    </>
  );
}

/** Account non attivi in questo ambiente: lo si dice, senza dettagli tecnici per il visitatore. */
export function NotAvailable() {
  return (
    <AccountPage title="Account">
      <p className="notice" role="status">Gli account non sono ancora disponibili. La guida, la mappa e i racconti gratuiti funzionano senza registrazione.</p>
    </AccountPage>
  );
}
