import Link from "next/link";
import type { ReactNode } from "react";
import type { StudioSession } from "../../lib/studio/server";
import { ROLE_LABELS } from "../../lib/studio/shared";
import { signOut } from "./actions";

/** Intestazione dello Studio: percorso di navigazione, utente e uscita. */
export function StudioHeader({ session, crumbs }: { session: StudioSession; crumbs: { href?: string; label: string }[] }) {
  const roles = session.me.admin ? ["Amministratore"] : [...new Set(session.me.roles.map((r) => ROLE_LABELS[r.role] ?? r.role))];
  return (
    <header className="st-header">
      <nav className="st-crumbs" aria-label="Percorso">
        <Link href="/studio">Studio</Link>
        {crumbs.map((c) => (
          <span key={c.label}>
            <span aria-hidden="true"> / </span>
            {c.href ? <Link href={c.href}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}
          </span>
        ))}
      </nav>
      <div className="st-user">
        <span title={roles.join(", ")}>{session.user.email}</span>
        <form action={signOut}>
          <button className="st-btn st-quiet" type="submit">Esci</button>
        </form>
      </div>
    </header>
  );
}

/** Esito dell'ultima azione (?ok= / ?errore=). */
export function Notice({ ok, errore }: { ok?: string; errore?: string }) {
  if (errore) return <p className="st-notice st-error" role="alert">{errore}</p>;
  if (ok) return <p className="st-notice st-ok" role="status">{ok}</p>;
  return null;
}

export function PackTabs({ pack, current }: { pack: string; current: "luoghi" | "percorsi" | "affermazioni" | "media" | null }) {
  const base = `/studio/${encodeURIComponent(pack)}`;
  const tabs = [
    ["luoghi", "Luoghi"],
    ["percorsi", "Percorsi"],
    ["affermazioni", "Affermazioni"],
    ["media", "Foto"],
  ] as const;
  return (
    <nav className="st-tabs" aria-label="Sezioni del territorio">
      {tabs.map(([key, label]) => (
        <Link key={key} href={`${base}/${key}`} aria-current={current === key ? "page" : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function Draft({ children }: { children: ReactNode }) {
  return <p className="st-hint">{children}</p>;
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
