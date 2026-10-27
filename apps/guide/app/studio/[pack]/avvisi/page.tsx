import Link from "next/link";
import { requireStaff, rpc } from "../../../../lib/studio/server";
import { friendlyError } from "../../../../lib/studio/shared";
import {
  inNoticeView, isNoticeView, NOTICE_STATUS_LABELS, NOTICE_VIEW_LABELS, NOTICE_VIEWS, noticeTiming, noticeTitle,
  type NoticeView, type StudioNotice,
} from "../../../../lib/studio/operational-notices";
import { PUBLICATION_LABELS } from "../../../../lib/studio/local-events";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../ui";

const TIMING_LABELS = { current: "in vigore oggi", future: "non ancora in vigore", expired: "scaduto" } as const;

/** Avvisi operativi del territorio: dati del giorno, fuori dal Territory Pack. Li vede solo chi può modificarlo. */
export default async function NoticesPage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const [{ data, error }, k] = await Promise.all([
    rpc<StudioNotice[]>(session.supabase, "studio_operational_notices", { p_pack: pack }),
    rpc<{ canEdit: boolean; defaultLocale: string; kind: string }>(session.supabase, "studio_pack", { p_pack: pack }),
  ]);
  const view: NoticeView = isNoticeView(one(q.vista)) ? (one(q.vista) as NoticeView) : "attivi";
  const all = data ?? [];
  const rows = all.filter((n) => inNoticeView(n, view));
  const base = `/studio/${encodeURIComponent(pack)}/avvisi`;
  const defaultLocale = k.data?.defaultLocale ?? "it";
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ label: pack }]} />
      <PackTabs pack={pack} current="avvisi" />
      <div className="st-titlebar">
        <h1>Avvisi</h1>
        {k.data?.canEdit && k.data.kind === "destination" && <Link className="st-btn st-primary" href={`${base}/nuovo`}>Nuovo avviso</Link>}
      </div>
      <p className="st-hint">
        Stato di oggi di luoghi e percorsi (chiuso, con limitazioni, solo su prenotazione…), con fonte ufficiale e date di
        validità. Pubblicati e in vigore, sono l&apos;unica base, oltre alle informazioni pratiche valide, da cui Gaia può dire
        se qualcosa oggi è aperto o chiuso; li cita con la fonte. Non fanno parte dei contenuti del territorio.
      </p>
      {k.data && k.data.kind !== "destination" && <p className="st-notice st-warn">Gli avvisi appartengono a una destinazione: questo territorio non lo è.</p>}
      <nav className="st-filters" aria-label="Vista">
        {NOTICE_VIEWS.map((v) => (
          <Link key={v} href={`${base}?vista=${v}`} aria-current={v === view ? "page" : undefined}>
            {NOTICE_VIEW_LABELS[v]} ({all.filter((n) => inNoticeView(n, v)).length})
          </Link>
        ))}
      </nav>
      <Notice ok={one(q.ok)} errore={one(q.errore) ?? (error ? friendlyError(error) : undefined)} />
      {rows.length === 0 && !error && <p>Nessun avviso in questa vista.</p>}
      <ul className="st-cards">
        {rows.map((n) => (
          <li key={n.id}>
            <Link className="st-card" href={`${base}/${encodeURIComponent(n.id)}`}>
              <strong>{noticeTitle(n, defaultLocale)}</strong>
              <span className="st-meta">
                {n.validFrom} → {n.validUntil} · {n.place ? `luogo ${n.place}` : n.route ? `percorso ${n.route}` : "tutta la destinazione"}
              </span>
              <span className="st-badges">
                <span className={`st-status ${n.publication === "published" ? "st-verified" : n.publication === "withdrawn" ? "st-rejected" : "st-draft"}`}>
                  {PUBLICATION_LABELS[n.publication]}
                </span>
                <span className="st-badge">{NOTICE_STATUS_LABELS[n.status]}</span>
                <span className="st-badge">{TIMING_LABELS[noticeTiming(n)]}</span>
                <span className="st-badge">{n.verifiedAt ? "fonte verificata" : "da verificare"}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
