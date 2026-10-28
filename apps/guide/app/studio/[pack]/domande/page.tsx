import Link from "next/link";
import { requireStaff, rpc } from "../../../../lib/studio/server";
import { friendlyError } from "../../../../lib/studio/shared";
import {
  formatDay, GAP_KIND_LABELS, GAP_REVIEW, GAP_REVIEW_LABELS, isGapReview, placeLabel, type StudioGapReview, type StudioQuestionGap,
} from "../../../../lib/studio/question-gaps";
import { deleteQuestionGap, setQuestionGapStatus } from "../../actions-questions";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../ui";

/**
 * Domande dei visitatori a cui la guida non ha saputo rispondere del tutto, le più frequenti prima. Le vede solo chi
 * può modificare il territorio; il testo è mascherato ma non anonimo e scade dopo 90 giorni dall'ultima volta.
 */
export default async function QuestionsPage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const { data, error } = await rpc<StudioQuestionGap[]>(session.supabase, "studio_question_gaps", { p_pack: pack });
  const vista = one(q.vista);
  const view: StudioGapReview = isGapReview(vista) ? vista : "new";
  const all = data ?? [];
  const rows = all.filter((g) => g.status === view);
  const base = `/studio/${encodeURIComponent(pack)}/domande`;
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ label: pack }]} />
      <PackTabs pack={pack} current="domande" />
      <div className="st-titlebar">
        <h1>Domande</h1>
      </div>
      <p className="st-hint">
        Domande dei visitatori a cui la guida non ha saputo rispondere del tutto: servono a decidere cosa aggiungere ai
        contenuti del territorio, che restano da scrivere e verificare come sempre. Il testo è mascherato in automatico
        (email, telefoni, codici), ma può contenere nomi o altri riferimenti: se trovi dati personali, elimina la domanda.
        Ogni domanda scade 90 giorni dopo l&apos;ultima volta che è stata fatta.
      </p>
      <nav className="st-filters" aria-label="Stato">
        {GAP_REVIEW.map((v) => (
          <Link key={v} href={`${base}?vista=${v}`} aria-current={v === view ? "page" : undefined}>
            {GAP_REVIEW_LABELS[v]} ({all.filter((g) => g.status === v).length})
          </Link>
        ))}
      </nav>
      <Notice ok={one(q.ok)} errore={one(q.errore) ?? (error ? friendlyError(error) : undefined)} />
      {rows.length === 0 && !error && <p>Nessuna domanda in questa vista.</p>}
      {rows.length > 0 && (
        <table className="st-table">
          <thead>
            <tr>
              <th>Domanda</th>
              <th>Volte</th>
              <th>Ultima volta</th>
              <th>Tipo</th>
              <th>Stato</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.id}>
                <td>
                  <strong>{g.question}</strong>
                  <div className="st-meta">
                    {g.locale.toUpperCase()}
                    {placeLabel(g.place) && <> · luogo: {placeLabel(g.place)}</>}
                    {placeLabel(g.selected) && placeLabel(g.selected) !== placeLabel(g.place) && <> · scelto: {placeLabel(g.selected)}</>}
                    {g.reason && <> · {g.reason}</>}
                  </div>
                  {g.webSources.length > 0 && (
                    <div className="st-meta">
                      Fonti trovate online (da verificare):{" "}
                      {g.webSources.map((s, i) => (
                        <span key={s.url}>
                          {i > 0 && ", "}
                          <a href={s.url} target="_blank" rel="noopener noreferrer nofollow">{s.title || s.url}</a>
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td>{g.hits}</td>
                <td>
                  {formatDay(g.lastSeen)}
                  {g.firstSeen !== g.lastSeen && <div className="st-meta">dal {formatDay(g.firstSeen)}</div>}
                </td>
                <td><span className="st-badge">{GAP_KIND_LABELS[g.kind] ?? g.kind}</span></td>
                <td>
                  <form action={setQuestionGapStatus} className="st-actions">
                    <input type="hidden" name="pack" value={pack} />
                    <input type="hidden" name="vista" value={view} />
                    <input type="hidden" name="id" value={g.id} />
                    <select name="status" defaultValue={g.status} aria-label="Stato della domanda">
                      {GAP_REVIEW.map((v) => (
                        <option key={v} value={v}>{GAP_REVIEW_LABELS[v]}</option>
                      ))}
                    </select>
                    <button className="st-btn" type="submit">Salva</button>
                  </form>
                  <details className="st-create">
                    <summary>Elimina…</summary>
                    <form action={deleteQuestionGap} className="st-form">
                      <input type="hidden" name="pack" value={pack} />
                      <input type="hidden" name="vista" value={view} />
                      <input type="hidden" name="id" value={g.id} />
                      <label className="st-inline">
                        <input type="checkbox" name="confirm" required />
                        Confermo: la domanda viene eliminata definitivamente
                      </label>
                      <div className="st-actions">
                        <button className="st-btn st-danger" type="submit">Elimina</button>
                      </div>
                    </form>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
