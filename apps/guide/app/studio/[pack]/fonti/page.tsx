import Link from "next/link";
import { requireStaff, rpc } from "../../../../lib/studio/server";
import { deleteHref, friendlyError } from "../../../../lib/studio/shared";
import { createSource } from "../../actions";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../ui";

interface SourceRow {
  slug: string;
  title: string;
  kind: string;
  authors: string[];
  institution: string | null;
  year: number | null;
  url: string | null;
  reliability: string;
  uses: number;
}

const KINDS: Record<string, string> = {
  book: "Libro",
  academic_paper: "Articolo scientifico",
  archive_document: "Documento d'archivio",
  inscription: "Iscrizione",
  catalogue_record: "Scheda di catalogo",
  institution: "Ente o istituzione",
  oral_testimony: "Testimonianza orale",
  website: "Sito web",
  other: "Altro",
};

export default async function SourcesPage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const [{ data, error }, k] = await Promise.all([
    rpc<SourceRow[]>(session.supabase, "studio_sources", { p_pack: pack }),
    rpc<{ canEdit: boolean }>(session.supabase, "studio_pack", { p_pack: pack }),
  ]);
  const sources = data ?? [];
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ label: pack }]} />
      <PackTabs pack={pack} current="fonti" />
      <h1>Fonti</h1>
      <p className="st-hint">Ogni fatto raccontato dalla guida cita almeno una fonte. Affidabilità: A (primaria o istituzionale) … D (debole).</p>
      <Notice ok={one(q.ok)} errore={one(q.errore) ?? (error ? friendlyError(error) : undefined)} />
      {k.data?.canEdit && (
        <details className="st-create" open={sources.length === 0}>
          <summary>Aggiungi una fonte</summary>
          <form action={createSource} className="st-form">
            <input type="hidden" name="pack" value={pack} />
            <label>
              Titolo
              <input name="title" required maxLength={300} />
            </label>
            <div className="st-row">
              <label>
                Tipo
                <select name="sourceKind" defaultValue="book">
                  {Object.entries(KINDS).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </label>
              <label>
                Affidabilità
                <select name="reliability" defaultValue="B">
                  <option value="A">A — primaria o istituzionale</option>
                  <option value="B">B — affidabile</option>
                  <option value="C">C — da confermare</option>
                  <option value="D">D — debole</option>
                </select>
              </label>
              <label>
                Anno
                <input name="year" type="number" min={-5000} max={2100} />
              </label>
            </div>
            <div className="st-row">
              <label>
                Autori (separati da virgole)
                <input name="authors" maxLength={300} />
              </label>
              <label>
                Ente
                <input name="institution" maxLength={200} />
              </label>
            </div>
            <div className="st-row">
              <label>
                Indirizzo (se online)
                <input name="url" type="url" maxLength={500} />
              </label>
              <label>
                Lingua
                <select name="language" defaultValue="it">
                  <option value="it">Italiano</option>
                  <option value="en">Inglese</option>
                  <option value="">Altra</option>
                </select>
              </label>
            </div>
            <div className="st-actions">
              <button className="st-btn st-primary" type="submit">Aggiungi la fonte</button>
            </div>
          </form>
        </details>
      )}
      {sources.length === 0 && !error && <p>Nessuna fonte.</p>}
      <table className="st-table">
        <thead>
          <tr>
            <th>Fonte</th>
            <th>Tipo</th>
            <th>Affidabilità</th>
            <th>Usata da</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.slug}>
              <td>
                {s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> : s.title}
                <span className="st-meta">
                  {[s.authors.join(", "), s.institution, s.year].filter(Boolean).join(" · ") || s.slug}
                </span>
              </td>
              <td>{KINDS[s.kind] ?? s.kind}</td>
              <td>{s.reliability}</td>
              <td>
                {s.uses} fatti
                {k.data?.canEdit && (
                  <span className="st-meta"><Link className="st-delete-link" href={deleteHref(pack, "source", s.slug)}>Elimina…</Link></span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
