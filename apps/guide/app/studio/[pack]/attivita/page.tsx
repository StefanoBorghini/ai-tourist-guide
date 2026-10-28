import Link from "next/link";
import { requireStaff, rpc } from "../../../../lib/studio/server";
import { friendlyError } from "../../../../lib/studio/shared";
import {
  BUSINESS_CATEGORY_LABELS, BUSINESS_PUBLICATION_LABELS, BUSINESS_VIEW_LABELS, BUSINESS_VIEWS, inBusinessView, isBusinessView, needsReverify,
  type StudioBusiness,
} from "../../../../lib/studio/local-businesses";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../ui";

/** Directory gratuita delle attività del territorio: dati operativi, fuori dal Territory Pack. Solo chi può modificarlo. */
export default async function BusinessesPage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const [{ data, error }, k] = await Promise.all([
    rpc<StudioBusiness[]>(session.supabase, "studio_local_businesses", { p_pack: pack }),
    rpc<{ canEdit: boolean; kind: string }>(session.supabase, "studio_pack", { p_pack: pack }),
  ]);
  const view = isBusinessView(one(q.vista)) ? (one(q.vista) as (typeof BUSINESS_VIEWS)[number]) : "tutte";
  const now = Date.now();
  const all = data ?? [];
  const rows = all.filter((b) => inBusinessView(b, view, now));
  const base = `/studio/${encodeURIComponent(pack)}/attivita`;
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ label: pack }]} />
      <PackTabs pack={pack} current="attivita" />
      <div className="st-titlebar">
        <h1>Attività</h1>
        {k.data?.canEdit && k.data.kind === "destination" && <Link className="st-btn st-primary" href={`${base}/nuova`}>Nuova attività</Link>}
      </div>
      <p className="st-hint">
        Bar, ristoranti, negozi, strutture ricettive e servizi: una directory gratuita e neutrale, consultabile nella guida
        senza account né acquisti. Compare ogni attività verificata e pubblicata, affiliata o no, in ordine alfabetico o di
        distanza: nessun badge e nessuna priorità. Non fa parte dei contenuti del territorio e la guida AI non la usa.
      </p>
      {k.data && k.data.kind !== "destination" && <p className="st-notice st-warn">Le attività appartengono a una destinazione: questo territorio non lo è.</p>}
      <nav className="st-filters" aria-label="Vista">
        {BUSINESS_VIEWS.map((v) => (
          <Link key={v} href={`${base}?vista=${v}`} aria-current={v === view ? "page" : undefined}>
            {BUSINESS_VIEW_LABELS[v]} ({all.filter((b) => inBusinessView(b, v, now)).length})
          </Link>
        ))}
      </nav>
      <Notice ok={one(q.ok)} errore={one(q.errore) ?? (error ? friendlyError(error) : undefined)} />
      {rows.length === 0 && !error && <p>Nessuna attività in questa vista.</p>}
      <ul className="st-cards">
        {rows.map((b) => (
          <li key={b.id}>
            <Link className="st-card" href={`${base}/${encodeURIComponent(b.id)}`}>
              <strong>{b.name}</strong>
              <span className="st-meta">{b.subcategory ?? BUSINESS_CATEGORY_LABELS[b.category]}{b.address ? ` · ${b.address}` : ""}</span>
              <span className="st-badges">
                <span className={`st-status ${b.publication === "published" ? "st-verified" : b.publication === "withdrawn" ? "st-rejected" : "st-draft"}`}>
                  {BUSINESS_PUBLICATION_LABELS[b.publication]}
                </span>
                <span className="st-badge">{!b.verifiedAt ? "da verificare" : needsReverify(b, now) ? "verifica scaduta" : "dati verificati"}</span>
                <span className="st-badge">{BUSINESS_CATEGORY_LABELS[b.category]}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
