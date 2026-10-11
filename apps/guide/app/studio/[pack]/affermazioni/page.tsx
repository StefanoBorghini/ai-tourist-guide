import Link from "next/link";
import { requireStaff, rpc } from "../../../../lib/studio/server";
import { deleteHref, friendlyError, STATUS_LABELS } from "../../../../lib/studio/shared";
import { confirmEvidence, createAssertion, reviewAssertion } from "../../actions";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../ui";

interface AssertionRow {
  slug: string;
  text: string | null;
  subject: string;
  type: string;
  certainty: string | null;
  status: string;
  authoredBy: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
  reviewNote: string | null;
  evidence: { position: number; title: string; attribution: string; locator: string | null; url: string | null }[];
  mine: boolean;
}

interface PackRow {
  id: string;
  canEdit: boolean;
  canVerify: boolean;
}

const FILTERS = ["in_review", "draft", "verified", "rejected"] as const;

export default async function AssertionsPage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const filter = (FILTERS as readonly string[]).includes(one(q.stato) ?? "") ? one(q.stato)! : "in_review";
  const session = await requireStaff();
  const [{ data, error }, packs, places, sources, k] = await Promise.all([
    rpc<AssertionRow[]>(session.supabase, "studio_assertions", { p_pack: pack, p_status: filter }),
    rpc<PackRow[]>(session.supabase, "studio_packs"),
    rpc<{ slug: string; name: string }[]>(session.supabase, "studio_places", { p_pack: pack }),
    rpc<{ slug: string; title: string }[]>(session.supabase, "studio_sources", { p_pack: pack }),
    rpc<{ defaultLocale: string; locales: string[] }>(session.supabase, "studio_pack", { p_pack: pack }),
  ]);
  const perms = packs.data?.find((p) => p.id === pack);
  const rows = data ?? [];
  const base = `/studio/${encodeURIComponent(pack)}/affermazioni`;
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ label: pack }]} />
      <PackTabs pack={pack} current="affermazioni" />
      <h1>Affermazioni</h1>
      <p className="st-hint">
        Regola dei quattro occhi: un'affermazione la verifica un esperto o la redazione, mai chi l'ha scritta, e solo con almeno una
        fonte confermata (non dedotta). Il rifiuto e il ritiro di una verifica richiedono un motivo; ogni decisione resta nello storico.
      </p>
      {(perms?.canEdit || perms?.canVerify) && (
        <details className="st-create">
          <summary>Nuova affermazione</summary>
          {(places.data ?? []).length === 0 ? (
            <p className="st-hint">Serve almeno un luogo di cui parlare.</p>
          ) : (
            <form action={createAssertion} className="st-form">
              <input type="hidden" name="pack" value={pack} />
              <div className="st-row">
                <label>
                  Di quale luogo parla
                  <select name="subject" required>
                    {(places.data ?? []).map((p) => (
                      <option key={p.slug} value={p.slug}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Tipo
                  <select name="type" defaultValue="fact">
                    <option value="fact">Fatto</option>
                    <option value="interpretation">Interpretazione</option>
                    <option value="hypothesis">Ipotesi</option>
                    <option value="tradition">Tradizione</option>
                    <option value="legend">Leggenda</option>
                  </select>
                </label>
                <label>
                  Certezza (fatti e interpretazioni)
                  <select name="certainty" defaultValue="established">
                    <option value="established">Accertata</option>
                    <option value="probable">Probabile</option>
                    <option value="uncertain">Incerta</option>
                  </select>
                </label>
              </div>
              {(k.data?.locales ?? ["it"]).map((l) => (
                <label key={l}>
                  Testo ({l})
                  <textarea name={`text_${l}`} rows={2} maxLength={2000} required={l === k.data?.defaultLocale} />
                </label>
              ))}
              <div className="st-row">
                <label>
                  Fonte
                  <select name="source" defaultValue="">
                    <option value="">— nessuna (resta in bozza finché non ne aggiungi una) —</option>
                    {(sources.data ?? []).map((s) => (
                      <option key={s.slug} value={s.slug}>{s.title}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Dove, nella fonte
                  <input name="locator" maxLength={300} placeholder="pagina, sezione o indirizzo" />
                </label>
              </div>
              <label className="st-inline">
                <input type="checkbox" name="submit" value="1" defaultChecked /> manda subito in revisione
              </label>
              <p className="st-hint">La verifica la fa un esperto o la redazione, mai chi scrive (regola dei quattro occhi).</p>
              <div className="st-actions">
                <button className="st-btn st-primary" type="submit">Crea l&apos;affermazione</button>
              </div>
            </form>
          )}
        </details>
      )}
      <nav className="st-filters" aria-label="Stato">
        {FILTERS.map((f) => (
          <Link key={f} href={`${base}?stato=${f}`} aria-current={f === filter ? "page" : undefined}>
            {STATUS_LABELS[f]}
          </Link>
        ))}
      </nav>
      <Notice ok={one(q.ok)} errore={one(q.errore) ?? (error ? friendlyError(error) : undefined)} />
      {rows.length === 0 && !error && <p>Nessuna affermazione {STATUS_LABELS[filter]?.toLowerCase()}.</p>}
      <ul className="st-assertions">
        {rows.map((a) => {
          const inferredOnly = a.evidence.length > 0 && a.evidence.every((e) => e.attribution === "inferred");
          return (
            <li key={a.slug} className="st-assertion">
              <div className="st-assertion-head">
                <span className={`st-status st-${a.status}`}>{STATUS_LABELS[a.status] ?? a.status}</span>
                <span className="st-meta">
                  {a.slug} · {a.subject} · {a.type}
                  {a.certainty ? ` (${a.certainty})` : ""}
                </span>
                {(perms?.canEdit || perms?.canVerify) && (
                  <Link className="st-delete-link" href={deleteHref(pack, "assertion", a.slug)}>Elimina…</Link>
                )}
              </div>
              <p className="st-assertion-text">{a.text ?? <em>senza testo</em>}</p>
              <details open={inferredOnly && !!perms?.canVerify && a.status === "in_review"}>
                <summary>
                  Fonti ({a.evidence.length}){inferredOnly ? " · solo dedotte" : ""}
                </summary>
                <ul>
                  {a.evidence.map((e) => (
                    <li key={e.position}>
                      {e.url ? (
                        <a href={e.url} target="_blank" rel="noreferrer">
                          {e.title}
                        </a>
                      ) : (
                        e.title
                      )}
                      {e.locator ? ` — ${e.locator}` : ""}
                      {e.attribution === "inferred" ? " (dedotta: da confermare sulla fonte)" : ""}
                      {e.attribution === "inferred" && perms?.canVerify && (
                        <form action={confirmEvidence} className="st-reject st-confirm">
                          <input type="hidden" name="pack" value={pack} />
                          <input type="hidden" name="slug" value={a.slug} />
                          <input type="hidden" name="stato" value={filter} />
                          <input type="hidden" name="position" value={e.position} />
                          <input name="locator" required maxLength={500} placeholder="Dove l'hai trovata: pagina, sezione o indirizzo" aria-label={`Punto della fonte ${e.title}`} />
                          <button className="st-btn" type="submit">Conferma la fonte</button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
              <p className="st-meta">
                Autore: {a.mine ? "tu" : a.authoredBy}
                {a.verifiedBy ? ` · verificata da ${a.verifiedBy === session.user.id ? "te" : a.verifiedBy}` : ""}
                {a.reviewNote ? ` · nota: ${a.reviewNote}` : ""}
              </p>
              <ReviewActions pack={pack} slug={a.slug} status={a.status} filter={filter} mine={a.mine} canEdit={!!perms?.canEdit} canVerify={!!perms?.canVerify} inferredOnly={inferredOnly} noEvidence={a.evidence.length === 0} />
            </li>
          );
        })}
      </ul>
    </main>
  );
}

function ReviewActions(p: { pack: string; slug: string; status: string; filter: string; mine: boolean; canEdit: boolean; canVerify: boolean; inferredOnly: boolean; noEvidence: boolean }) {
  const hidden = (
    <>
      <input type="hidden" name="pack" value={p.pack} />
      <input type="hidden" name="slug" value={p.slug} />
      <input type="hidden" name="stato" value={p.filter} />
    </>
  );
  if ((p.status === "draft" || p.status === "rejected") && (p.canEdit || p.canVerify)) {
    return (
      <form action={reviewAssertion} className="st-review">
        {hidden}
        <input type="hidden" name="action" value="submit" />
        <button className="st-btn" type="submit">Manda in revisione</button>
      </form>
    );
  }
  if (p.status === "in_review" && p.canVerify) {
    const blocked = p.mine ? "Hai scritto tu questa affermazione: la verifica un'altra persona." : p.noEvidence ? "Nessuna fonte collegata." : p.inferredOnly ? "Fonti solo dedotte: confermale prima di verificare." : null;
    return (
      <div className="st-review">
        <form action={reviewAssertion}>
          {hidden}
          <input type="hidden" name="action" value="verify" />
          <button className="st-btn st-primary" type="submit" disabled={!!blocked} title={blocked ?? undefined}>Verifica</button>
        </form>
        <form action={reviewAssertion} className="st-reject">
          {hidden}
          <input type="hidden" name="action" value="reject" />
          <input name="note" placeholder="Motivo del rifiuto" required maxLength={2000} aria-label="Motivo del rifiuto" />
          <button className="st-btn" type="submit">Respingi</button>
        </form>
        {blocked && <p className="st-hint">{blocked}</p>}
      </div>
    );
  }
  if (p.status === "verified" && (p.canEdit || p.canVerify)) {
    return (
      <form action={reviewAssertion} className="st-review st-reject">
        {hidden}
        <input type="hidden" name="action" value="reopen" />
        <input name="note" placeholder="Perché va ricontrollata" required maxLength={2000} aria-label="Motivo del ritiro della verifica" />
        <button className="st-btn" type="submit">Riporta in revisione</button>
      </form>
    );
  }
  return null;
}
