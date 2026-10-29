import { requireStaff, rpc } from "../../../../../lib/studio/server";
import { friendlyError } from "../../../../../lib/studio/shared";
import { formatStamp } from "../../../../../lib/studio/local-events";
import {
  BUSINESS_CATEGORY_LABELS, BUSINESS_PUBLICATION_LABELS, formValuesFromBusiness, needsReverify, REVERIFY_DAYS, type StudioBusiness,
} from "../../../../../lib/studio/local-businesses";
import { deleteLocalBusiness, setLocalBusinessPublication, verifyLocalBusiness } from "../../../actions-businesses";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../../ui";
import { BusinessForm } from "../BusinessForm";
import { BusinessPhotos } from "./BusinessPhotos";

export default async function BusinessPage({ params, searchParams }: { params: Promise<{ pack: string; id: string }>; searchParams: SearchParams }) {
  const { pack, id } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const [list, k, dest] = await Promise.all([
    rpc<StudioBusiness[]>(session.supabase, "studio_local_businesses", { p_pack: pack }),
    rpc<{ canEdit: boolean; canPublish: boolean; locales: string[]; defaultLocale: string }>(session.supabase, "studio_pack", { p_pack: pack }),
    session.supabase.from("destinations").select("timezone").eq("pack_id", pack).maybeSingle(),
  ]);
  const b = (list.data ?? []).find((x) => x.id === id) ?? null;
  const base = `/studio/${encodeURIComponent(pack)}/attivita`;
  const tz = (dest.data as { timezone?: string } | null)?.timezone ?? "UTC";
  const locales = k.data?.locales ?? ["it"];
  const canEdit = k.data?.canEdit === true;
  const canPublish = k.data?.canPublish === true;
  const hidden = b && (
    <>
      <input type="hidden" name="pack" value={pack} />
      <input type="hidden" name="id" value={b.id} />
    </>
  );
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ href: base, label: pack }, { label: b?.name ?? "Attività" }]} />
      <PackTabs pack={pack} current="attivita" />
      {!b ? (
        <Notice errore={list.error ? friendlyError(list.error) : "Attività non trovata o non visibile con il tuo ruolo."} />
      ) : (
        <>
          <h1>{b.name}</h1>
          <Notice ok={one(q.ok)} errore={one(q.errore)} />
          <p className="st-meta">{BUSINESS_CATEGORY_LABELS[b.category]}{b.subcategory ? ` · ${b.subcategory}` : ""} · {b.slug}</p>
          <p className="st-badges">
            <span className={`st-status ${b.publication === "published" ? "st-verified" : b.publication === "withdrawn" ? "st-rejected" : "st-draft"}`}>
              {BUSINESS_PUBLICATION_LABELS[b.publication]}
            </span>
            <span className="st-badge">{b.verifiedAt ? `dati verificati il ${formatStamp(b.verifiedAt, tz)}` : "dati da verificare"}</span>
          </p>

          <div className="st-grid-2">
            <section className="st-panel">
              <h2>Verifica dei dati</h2>
              <p className="st-hint">
                Controlla nome, indirizzo, recapiti e orari (sul posto, al telefono o sul sito dell&apos;attività). Dopo {REVERIFY_DAYS} giorni
                la guida nasconde gli orari finché non riverifichi.
              </p>
              {b.verifiedAt && (
                <p className="st-hint">
                  Ultima verifica: {formatStamp(b.verifiedAt, tz)}{b.verificationNote ? ` — ${b.verificationNote}` : ""} (nota interna, mai pubblicata).
                  {needsReverify(b) ? " Verifica scaduta." : ""}
                </p>
              )}
              {canEdit && (
                <form action={verifyLocalBusiness} className="st-form">
                  {hidden}
                  <label>
                    Nota di verifica (interna)
                    <input name="note" maxLength={500} placeholder="es. confermato al telefono con il titolare" />
                  </label>
                  <div className="st-actions">
                    <button className="st-btn" type="submit">Ho verificato i dati ora</button>
                  </div>
                </form>
              )}
            </section>

            <section className="st-panel">
              <h2>Pubblicazione</h2>
              {b.publishedAt && <p className="st-hint">Pubblicata l&apos;ultima volta il {formatStamp(b.publishedAt, tz)}.</p>}
              {b.publication !== "published" && !b.verifiedAt && <p className="st-hint">Per pubblicare: verifica prima i dati.</p>}
              <div className="st-actions">
                {canPublish && b.publication !== "published" && (
                  <form action={setLocalBusinessPublication}>
                    {hidden}
                    <input type="hidden" name="to" value="published" />
                    <button className="st-btn st-primary" type="submit" disabled={!b.verifiedAt}>Pubblica</button>
                  </form>
                )}
                {canPublish && b.publication === "published" && (
                  <form action={setLocalBusinessPublication}>
                    {hidden}
                    <input type="hidden" name="to" value="withdrawn" />
                    <button className="st-btn" type="submit">Ritira</button>
                  </form>
                )}
                {canEdit && b.publication === "withdrawn" && (
                  <form action={setLocalBusinessPublication}>
                    {hidden}
                    <input type="hidden" name="to" value="draft" />
                    <button className="st-btn st-quiet" type="submit">Riporta in bozza</button>
                  </form>
                )}
              </div>
              {!canPublish && <p className="st-hint">Pubblicare e ritirare spetta a chi pubblica il territorio.</p>}
            </section>
          </div>

          <h2>Dati dell&apos;attività</h2>
          <BusinessForm
            pack={pack}
            id={b.id}
            values={formValuesFromBusiness(b, locales)}
            locales={locales}
            defaultLocale={k.data?.defaultLocale ?? "it"}
            published={b.publication === "published"}
            readOnly={!canEdit}
          />

          <BusinessPhotos pack={pack} business={b.id} photos={b.photos ?? []} config={session.config ?? null} canEdit={canEdit} />

          {canEdit && (b.publication === "draft" || session.me.admin) && (
            <details className="st-create">
              <summary>Elimina questa attività…</summary>
              <form action={deleteLocalBusiness} className="st-form">
                {hidden}
                <label className="st-inline">
                  <input type="checkbox" name="confirm" required />
                  Confermo: l&apos;attività viene eliminata definitivamente
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
