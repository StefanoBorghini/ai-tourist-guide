import { requireStaff, rpc } from "../../../../../lib/studio/server";
import { friendlyError } from "../../../../../lib/studio/shared";
import {
  EVENT_STATUS_LABELS, EVENT_STATUSES, eventTitle, eventWhen, formatStamp, formValuesFromEvent, publishBlockers, PUBLICATION_LABELS,
  type StudioEvent,
} from "../../../../../lib/studio/local-events";
import { deleteLocalEvent, setLocalEventPublication, setLocalEventStatus, verifyLocalEvent } from "../../../actions-events";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../../ui";
import { EventForm } from "../EventForm";

export default async function EventPage({ params, searchParams }: { params: Promise<{ pack: string; id: string }>; searchParams: SearchParams }) {
  const { pack, id } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const [list, k, places, dest] = await Promise.all([
    rpc<StudioEvent[]>(session.supabase, "studio_local_events", { p_pack: pack }),
    rpc<{ canEdit: boolean; canPublish: boolean; locales: string[]; defaultLocale: string }>(session.supabase, "studio_pack", { p_pack: pack }),
    rpc<{ slug: string; name: string }[]>(session.supabase, "studio_places", { p_pack: pack }),
    session.supabase.from("destinations").select("timezone").eq("pack_id", pack).maybeSingle(),
  ]);
  const event = (list.data ?? []).find((e) => e.id === id) ?? null;
  const base = `/studio/${encodeURIComponent(pack)}/eventi`;
  const tz = (dest.data as { timezone?: string } | null)?.timezone ?? "Europe/Rome";
  const locales = k.data?.locales ?? ["it"];
  const defaultLocale = k.data?.defaultLocale ?? "it";
  const canEdit = k.data?.canEdit === true;
  const canPublish = k.data?.canPublish === true;
  const title = event ? eventTitle(event, defaultLocale) : "Evento";
  const blockers = event ? publishBlockers(event) : [];
  const hidden = event && (
    <>
      <input type="hidden" name="pack" value={pack} />
      <input type="hidden" name="id" value={event.id} />
    </>
  );
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ href: base, label: pack }, { label: title }]} />
      <PackTabs pack={pack} current="eventi" />
      {!event ? (
        <Notice errore={list.error ? friendlyError(list.error) : "Evento non trovato o non visibile con il tuo ruolo."} />
      ) : (
        <>
          <h1>{title}</h1>
          <Notice ok={one(q.ok)} errore={one(q.errore)} />
          <p className="st-meta">
            {eventWhen(event)} · {event.venueName} · {event.slug} · fuso {tz}
          </p>
          <p className="st-badges">
            <span className={`st-status ${event.publication === "published" ? "st-verified" : event.publication === "withdrawn" ? "st-rejected" : "st-draft"}`}>
              {PUBLICATION_LABELS[event.publication]}
            </span>
            <span className="st-badge">{EVENT_STATUS_LABELS[event.status]}</span>
            <span className="st-badge">{event.verifiedAt ? `fonte verificata il ${formatStamp(event.verifiedAt, tz)}` : "fonte da verificare"}</span>
          </p>

          <div className="st-grid-2">
            <section className="st-panel">
              <h2>Verifica della fonte</h2>
              {event.sourceUrl ? (
                <p>
                  <a href={event.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">{event.sourceUrl}</a>
                </p>
              ) : (
                <p className="st-hint">Manca l&apos;indirizzo della fonte ufficiale: aggiungilo nel modulo qui sotto.</p>
              )}
              {event.verifiedAt && (
                <p className="st-hint">
                  Ultima verifica: {formatStamp(event.verifiedAt, tz)}{event.verificationNote ? ` — ${event.verificationNote}` : ""} (nota interna, mai pubblicata).
                </p>
              )}
              {canEdit && event.sourceUrl && (
                <form action={verifyLocalEvent} className="st-form">
                  {hidden}
                  <label>
                    Nota di verifica (interna)
                    <input name="note" maxLength={500} placeholder="es. confermato sul sito del Comune" />
                  </label>
                  <div className="st-actions">
                    <button className="st-btn" type="submit">Ho verificato la fonte ora</button>
                  </div>
                </form>
              )}
            </section>

            <section className="st-panel">
              <h2>Pubblicazione</h2>
              {event.publishedAt && <p className="st-hint">Pubblicato l&apos;ultima volta il {formatStamp(event.publishedAt, tz)}.</p>}
              {event.publication !== "published" && blockers.length > 0 && (
                <p className="st-hint">Per pubblicare: {blockers.join("; ")}.</p>
              )}
              <div className="st-actions">
                {canPublish && event.publication !== "published" && (
                  <form action={setLocalEventPublication}>
                    {hidden}
                    <input type="hidden" name="to" value="published" />
                    <button className="st-btn st-primary" type="submit" disabled={blockers.length > 0}>Pubblica</button>
                  </form>
                )}
                {canPublish && event.publication === "published" && (
                  <form action={setLocalEventPublication}>
                    {hidden}
                    <input type="hidden" name="to" value="withdrawn" />
                    <button className="st-btn" type="submit">Ritira</button>
                  </form>
                )}
                {canEdit && event.publication === "withdrawn" && (
                  <form action={setLocalEventPublication}>
                    {hidden}
                    <input type="hidden" name="to" value="draft" />
                    <button className="st-btn st-quiet" type="submit">Riporta in bozza</button>
                  </form>
                )}
              </div>
              {!canPublish && <p className="st-hint">Pubblicare e ritirare spetta a chi pubblica il territorio.</p>}
            </section>

            <section className="st-panel">
              <h2>Stato dell&apos;evento</h2>
              <p className="st-hint">
                Annullato, rinviato o da confermare: vale subito, anche per un evento pubblicato, senza ritirarlo. La nota
                è pubblica. Se è rinviato a una data nota, correggi le date nel modulo (con la verifica) e rimettilo «Previsto».
              </p>
              {canEdit && (
                <form action={setLocalEventStatus} className="st-form">
                  {hidden}
                  <div className="st-row">
                    <label>
                      Stato
                      <select name="status" defaultValue={event.status}>
                        {EVENT_STATUSES.map((s) => (
                          <option key={s} value={s}>{EVENT_STATUS_LABELS[s]}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Nota pubblica
                      <input name="note" maxLength={300} defaultValue={event.statusNote ?? ""} placeholder="es. annullato per maltempo" />
                    </label>
                  </div>
                  <div className="st-actions">
                    <button className="st-btn" type="submit">Aggiorna lo stato</button>
                  </div>
                </form>
              )}
            </section>
          </div>

          <h2>Dati dell&apos;evento</h2>
          <EventForm
            pack={pack}
            id={event.id}
            values={formValuesFromEvent(event, locales)}
            locales={locales}
            defaultLocale={defaultLocale}
            places={places.data ?? []}
            published={event.publication === "published"}
            readOnly={!canEdit}
          />

          {canEdit && (event.publication === "draft" || session.me.admin) && (
            <details className="st-create">
              <summary>Elimina questo evento…</summary>
              <form action={deleteLocalEvent} className="st-form">
                {hidden}
                <label className="st-inline">
                  <input type="checkbox" name="confirm" required />
                  Confermo: l&apos;evento viene eliminato definitivamente
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
