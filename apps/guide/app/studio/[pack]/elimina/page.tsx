import Link from "next/link";
import { requireStaff, rpc } from "../../../../lib/studio/server";
import { afterDeleteHref, DELETE_KINDS, friendlyError, isDeleteKind } from "../../../../lib/studio/shared";
import { deleteItem } from "../../actions";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../ui";

interface DeletePlan {
  kind: string;
  name: string;
  items: { kind: string; slug?: string; label?: string; count?: number }[];
  blockers: string[];
  notes: string[];
  files: string[];
  allowed: boolean;
}

/**
 * Conferma di un'eliminazione: cosa sparisce insieme all'elemento, cosa lo impedisce.
 * Il piano lo calcola il database (studio_delete_plan), che lo ricontrolla al momento di eliminare.
 */
export default async function DeletePage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const kind = one(q.tipo);
  const slug = one(q.slug) ?? "";
  const base = `/studio/${encodeURIComponent(pack)}`;
  if (!isDeleteKind(kind)) {
    return (
      <main className="st-page">
        <StudioHeader session={session} crumbs={[{ href: base, label: pack }, { label: "Elimina" }]} />
        <Notice errore="Tipo da eliminare non valido." />
      </main>
    );
  }
  const k = DELETE_KINDS[kind];
  const { data: plan, error } = await rpc<DeletePlan>(session.supabase, "studio_delete_plan", {
    p_pack: pack,
    p_kind: kind,
    p_slug: kind === "pack" ? null : slug,
  });
  const cancel = kind === "pack" ? `${base}/panoramica` : afterDeleteHref(pack, kind);

  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ href: base, label: pack }, { label: `Elimina ${k.label}` }]} />
      {kind !== "pack" && <PackTabs pack={pack} current={null} />}
      <h1>Eliminare {k.the}{plan ? ` «${plan.name}»` : ""}?</h1>
      <Notice errore={one(q.errore) ?? (error ? friendlyError(error) : undefined)} />
      {plan && (
        <section className="st-panel st-delete" aria-labelledby="piano">
          <h2 id="piano">{plan.allowed ? "Cosa succede" : "Per ora non si può eliminare"}</h2>
          {plan.blockers.length > 0 && (
            <ul className="st-report">
              {plan.blockers.map((b) => (
                <li key={b} className="st-e">{b}</li>
              ))}
            </ul>
          )}
          {plan.items.length > 0 && (
            <>
              <p>{kind === "pack" ? "Si elimina tutto il contenuto del territorio:" : "Insieme si eliminano anche:"}</p>
              <ul className="st-report">
                {plan.items.map((i) => (
                  <li key={`${i.kind}:${i.slug ?? ""}`}>
                    {i.count !== undefined
                      ? `${i.count} × ${DELETE_KINDS[i.kind as keyof typeof DELETE_KINDS]?.label ?? i.kind}`
                      : `${DELETE_KINDS[i.kind as keyof typeof DELETE_KINDS]?.label ?? i.kind}: ${i.label ?? i.slug}`}
                  </li>
                ))}
              </ul>
            </>
          )}
          {plan.files.length > 0 && <p className="st-meta">File tolti dal bucket media: {plan.files.length}</p>}
          {plan.notes.map((n) => (
            <p key={n} className="st-hint">{n}</p>
          ))}
          <p className="st-hint">
            Prima di eliminare, lo Studio salva nello storico una copia completa del territorio com'è adesso: con quella si può
            ripristinare. L'app pubblicata non cambia finché non si ripubblica.
          </p>
          <form action={deleteItem} className="st-form">
            <input type="hidden" name="pack" value={pack} />
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="slug" value={slug} />
            {kind === "pack" && plan.allowed && (
              <label>
                Per confermare scrivi l'identificativo del territorio ({pack})
                <input name="confirm" required autoComplete="off" spellCheck={false} />
              </label>
            )}
            <div className="st-actions">
              <Link className="st-btn" href={cancel}>Annulla</Link>
              {plan.allowed && (
                <button className="st-btn st-danger" type="submit">Elimina definitivamente</button>
              )}
            </div>
          </form>
        </section>
      )}
    </main>
  );
}
