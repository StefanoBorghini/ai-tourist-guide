import Link from "next/link";
import { requireStaff, rpc } from "../../../../lib/studio/server";
import { friendlyError } from "../../../../lib/studio/shared";
import {
  CATEGORY_LABELS, EVENT_STATUS_LABELS, EVENT_VIEW_LABELS, EVENT_VIEWS, eventTitle, eventWhen, inView, isEventView, PUBLICATION_LABELS,
  type StudioEvent,
} from "../../../../lib/studio/local-events";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../ui";

/** Eventi del giorno del territorio: dati operativi, fuori dal Territory Pack. Li vede solo chi può modificarlo. */
export default async function EventsPage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const [{ data, error }, k] = await Promise.all([
    rpc<StudioEvent[]>(session.supabase, "studio_local_events", { p_pack: pack }),
    rpc<{ canEdit: boolean; defaultLocale: string; kind: string }>(session.supabase, "studio_pack", { p_pack: pack }),
  ]);
  const view = isEventView(one(q.vista)) ? (one(q.vista) as (typeof EVENT_VIEWS)[number]) : "prossimi";
  const now = Date.now();
  const all = data ?? [];
  // In arrivo: dal più vicino; le altre viste come le restituisce il database (dal più recente).
  const rows = all.filter((e) => inView(e, view, now));
  if (view === "prossimi") rows.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const base = `/studio/${encodeURIComponent(pack)}/eventi`;
  const defaultLocale = k.data?.defaultLocale ?? "it";
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ label: pack }]} />
      <PackTabs pack={pack} current="eventi" />
      <div className="st-titlebar">
        <h1>Eventi</h1>
        {k.data?.canEdit && k.data.kind === "destination" && <Link className="st-btn st-primary" href={`${base}/nuovo`}>Nuovo evento</Link>}
      </div>
      <p className="st-hint">
        Appuntamenti con data e fonte ufficiale, mostrati nella guida solo dopo verifica e pubblicazione. Non fanno parte
        dei contenuti del territorio e la guida AI non li racconta.
      </p>
      {k.data && k.data.kind !== "destination" && <p className="st-notice st-warn">Gli eventi appartengono a una destinazione: questo territorio non lo è.</p>}
      <nav className="st-filters" aria-label="Vista">
        {EVENT_VIEWS.map((v) => (
          <Link key={v} href={`${base}?vista=${v}`} aria-current={v === view ? "page" : undefined}>
            {EVENT_VIEW_LABELS[v]} ({all.filter((e) => inView(e, v, now)).length})
          </Link>
        ))}
      </nav>
      <Notice ok={one(q.ok)} errore={one(q.errore) ?? (error ? friendlyError(error) : undefined)} />
      {rows.length === 0 && !error && <p>Nessun evento in questa vista.</p>}
      <ul className="st-cards">
        {rows.map((e) => (
          <li key={e.id}>
            <Link className="st-card" href={`${base}/${encodeURIComponent(e.id)}`}>
              <strong>{eventTitle(e, defaultLocale)}</strong>
              <span className="st-meta">{eventWhen(e)} · {e.venueName}</span>
              <span className="st-badges">
                <span className={`st-status ${e.publication === "published" ? "st-verified" : e.publication === "withdrawn" ? "st-rejected" : "st-draft"}`}>
                  {PUBLICATION_LABELS[e.publication]}
                </span>
                {e.status !== "scheduled" && <span className="st-badge">{EVENT_STATUS_LABELS[e.status]}</span>}
                <span className="st-badge">{e.verifiedAt ? "fonte verificata" : "da verificare"}</span>
                <span className="st-badge">{CATEGORY_LABELS[e.category]}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
