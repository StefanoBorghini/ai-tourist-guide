import { requireStaff, rpc } from "../../../../../lib/studio/server";
import { friendlyError } from "../../../../../lib/studio/shared";
import { formatStamp, PUBLICATION_LABELS } from "../../../../../lib/studio/local-events";
import {
  formValuesFromNotice, NOTICE_STATUS_LABELS, noticePublishBlockers, noticeTiming, noticeTitle, type StudioNotice,
} from "../../../../../lib/studio/operational-notices";
import { deleteOperationalNotice, setOperationalNoticePublication, verifyOperationalNotice } from "../../../actions-notices";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../../ui";
import { NoticeForm } from "../NoticeForm";

const TIMING_LABELS = { current: "in vigore oggi", future: "non ancora in vigore", expired: "scaduto" } as const;

export default async function NoticePage({ params, searchParams }: { params: Promise<{ pack: string; id: string }>; searchParams: SearchParams }) {
  const { pack, id } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const [list, k, places, routes, dest] = await Promise.all([
    rpc<StudioNotice[]>(session.supabase, "studio_operational_notices", { p_pack: pack }),
    rpc<{ canEdit: boolean; canPublish: boolean; locales: string[]; defaultLocale: string }>(session.supabase, "studio_pack", { p_pack: pack }),
    rpc<{ slug: string; name: string }[]>(session.supabase, "studio_places", { p_pack: pack }),
    rpc<{ slug: string; name: string }[]>(session.supabase, "studio_routes", { p_pack: pack }),
    session.supabase.from("destinations").select("timezone").eq("pack_id", pack).maybeSingle(),
  ]);
  const notice = (list.data ?? []).find((n) => n.id === id) ?? null;
  const base = `/studio/${encodeURIComponent(pack)}/avvisi`;
  const tz = (dest.data as { timezone?: string } | null)?.timezone ?? "Europe/Rome";
  const locales = k.data?.locales ?? ["it"];
  const defaultLocale = k.data?.defaultLocale ?? "it";
  const canEdit = k.data?.canEdit === true;
  const canPublish = k.data?.canPublish === true;
  const title = notice ? noticeTitle(notice, defaultLocale) : "Avviso";
  const blockers = notice ? noticePublishBlockers(notice) : [];
  const hidden = notice && (
    <>
      <input type="hidden" name="pack" value={pack} />
      <input type="hidden" name="id" value={notice.id} />
    </>
  );
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ href: base, label: pack }, { label: title }]} />
      <PackTabs pack={pack} current="avvisi" />
      {!notice ? (
        <Notice errore={list.error ? friendlyError(list.error) : "Avviso non trovato o non visibile con il tuo ruolo."} />
      ) : (
        <>
          <h1>{title}</h1>
          <Notice ok={one(q.ok)} errore={one(q.errore)} />
          <p className="st-meta">
            {notice.validFrom} → {notice.validUntil} · {notice.slug} · oggi {notice.today} (fuso {tz})
          </p>
          <p className="st-badges">
            <span className={`st-status ${notice.publication === "published" ? "st-verified" : notice.publication === "withdrawn" ? "st-rejected" : "st-draft"}`}>
              {PUBLICATION_LABELS[notice.publication]}
            </span>
            <span className="st-badge">{NOTICE_STATUS_LABELS[notice.status]}</span>
            <span className="st-badge">{TIMING_LABELS[noticeTiming(notice)]}</span>
            <span className="st-badge">{notice.verifiedAt ? `fonte verificata il ${formatStamp(notice.verifiedAt, tz)}` : "fonte da verificare"}</span>
          </p>

          <div className="st-grid-2">
            <section className="st-panel">
              <h2>Verifica della fonte</h2>
              {notice.sourceUrl ? (
                <p>
                  <a href={notice.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">{notice.sourceUrl}</a>
                </p>
              ) : (
                <p className="st-hint">Manca l&apos;indirizzo della fonte ufficiale: aggiungilo nel modulo qui sotto.</p>
              )}
              {notice.verifiedAt && (
                <p className="st-hint">
                  Ultima verifica: {formatStamp(notice.verifiedAt, tz)}{notice.verificationNote ? ` — ${notice.verificationNote}` : ""} (nota interna, mai pubblicata).
                </p>
              )}
              {canEdit && notice.sourceUrl && (
                <form action={verifyOperationalNotice} className="st-form">
                  {hidden}
                  <label>
                    Nota di verifica (interna)
                    <input name="note" maxLength={500} placeholder="es. confermato sul sito del Parco" />
                  </label>
                  <div className="st-actions">
                    <button className="st-btn" type="submit">Ho verificato la fonte ora</button>
                  </div>
                </form>
              )}
            </section>

            <section className="st-panel">
              <h2>Pubblicazione</h2>
              {notice.publishedAt && <p className="st-hint">Pubblicato l&apos;ultima volta il {formatStamp(notice.publishedAt, tz)}.</p>}
              {notice.publication !== "published" && blockers.length > 0 && <p className="st-hint">Per pubblicare: {blockers.join("; ")}.</p>}
              <p className="st-hint">Pubblicato e in vigore, Gaia lo usa entro un minuto; ritirato o scaduto, smette di usarlo.</p>
              <div className="st-actions">
                {canPublish && notice.publication !== "published" && (
                  <form action={setOperationalNoticePublication}>
                    {hidden}
                    <input type="hidden" name="to" value="published" />
                    <button className="st-btn st-primary" type="submit" disabled={blockers.length > 0}>Pubblica</button>
                  </form>
                )}
                {canPublish && notice.publication === "published" && (
                  <form action={setOperationalNoticePublication}>
                    {hidden}
                    <input type="hidden" name="to" value="withdrawn" />
                    <button className="st-btn" type="submit">Ritira</button>
                  </form>
                )}
                {canEdit && notice.publication === "withdrawn" && (
                  <form action={setOperationalNoticePublication}>
                    {hidden}
                    <input type="hidden" name="to" value="draft" />
                    <button className="st-btn st-quiet" type="submit">Riporta in bozza</button>
                  </form>
                )}
              </div>
              {!canPublish && <p className="st-hint">Pubblicare e ritirare spetta a chi pubblica il territorio.</p>}
            </section>
          </div>

          <h2>Dati dell&apos;avviso</h2>
          <NoticeForm
            pack={pack}
            id={notice.id}
            values={formValuesFromNotice(notice, locales)}
            locales={locales}
            defaultLocale={defaultLocale}
            places={places.data ?? []}
            routes={routes.data ?? []}
            published={notice.publication === "published"}
            readOnly={!canEdit}
          />

          {canEdit && (notice.publication === "draft" || session.me.admin) && (
            <details className="st-create">
              <summary>Elimina questo avviso…</summary>
              <form action={deleteOperationalNotice} className="st-form">
                {hidden}
                <label className="st-inline">
                  <input type="checkbox" name="confirm" required />
                  Confermo: l&apos;avviso viene eliminato definitivamente
                </label>
                <div className="st-actions">
                  <button className="st-btn st-danger" type="submit">Elimina</button>
                </div>
              </form>
            </details>
          )}
        </>
      )}
    </main>
  );
}
