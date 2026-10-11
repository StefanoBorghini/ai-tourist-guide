import Link from "next/link";
import { checkReadiness, requireStaff, rpc } from "../../../../lib/studio/server";
import { deleteHref, friendlyError } from "../../../../lib/studio/shared";
import { setPackStatus, updatePack } from "../../actions";
import { KIND_LABELS, Notice, one, PackStatus, PackTabs, STAGE_LABELS, StudioHeader, type SearchParams } from "../../ui";

interface PackDetail {
  id: string;
  kind: string;
  title: Record<string, string>;
  description: Record<string, string>;
  defaultLocale: string;
  locales: string[];
  releaseStage: string;
  version: string;
  fictional: boolean;
  organization: { id: string; name: string } | null;
  dependsOn: string[];
  dependents: string[];
  status: string | null;
  publishedAt: string | null;
  cover: string | null;
  coverCandidates: string[];
  publications: { status: string; createdAt: string; report: { ok?: boolean; bundles?: { locale: string; units: number; places: number }[] } | null }[];
  counts: Record<string, number>;
  canEdit: boolean;
  canPublish: boolean;
}

export default async function OverviewPage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const [{ data: k, error }, all] = await Promise.all([
    rpc<PackDetail>(session.supabase, "studio_pack", { p_pack: pack }),
    rpc<{ id: string; kind: string; title: Record<string, string> }[]>(session.supabase, "studio_packs"),
  ]);
  if (!k) {
    return (
      <main className="st-page">
        <StudioHeader session={session} crumbs={[{ label: pack }]} />
        <Notice errore={error ? friendlyError(error) : "Territorio non trovato o non visibile con il tuo ruolo."} />
      </main>
    );
  }
  const report = one(q.controllo) ? await checkReadiness(session.supabase, pack) : null;
  const base = `/studio/${encodeURIComponent(pack)}`;
  const name = k.title[k.defaultLocale] ?? k.title.it ?? pack;
  const candidates = (all.data ?? []).filter((p) => p.id !== pack && !k.dependents.includes(p.id));
  const ro = !k.canEdit;
  const isDestination = k.kind === "destination";
  const statusForm = (status: string, label: string, primary = false) => (
    <form action={setPackStatus}>
      <input type="hidden" name="pack" value={pack} />
      <input type="hidden" name="status" value={status} />
      <button className={`st-btn${primary ? " st-primary" : ""}`} type="submit">{label}</button>
    </form>
  );

  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ label: name }]} />
      <PackTabs pack={pack} current="panoramica" />
      <div className="st-titlebar">
        <h1>{name}</h1>
        <PackStatus status={k.status} />
      </div>
      <p className="st-meta">
        {k.id} · {KIND_LABELS[k.kind] ?? k.kind} · versione {k.version} · {STAGE_LABELS[k.releaseStage] ?? k.releaseStage}
        {k.organization ? ` · ${k.organization.name}` : ""}
        {k.fictional ? " · fittizio (di prova: non si pubblica)" : ""}
        {k.dependsOn.length ? ` · dentro ${k.dependsOn.join(", ")}` : ""}
        {k.dependents.length ? ` · contiene ${k.dependents.join(", ")}` : ""}
      </p>
      <Notice ok={one(q.ok)} errore={one(q.errore)} />

      <div className="st-grid-2">
        <section className="st-panel" aria-labelledby="contenuti">
          <h2 id="contenuti">Contenuti</h2>
          <ul className="st-report">
            <li><Link href={`${base}/luoghi`}>{k.counts.places} luoghi</Link>{k.canEdit && <> · <Link href={`${base}/luoghi/nuovo`}>aggiungi</Link></>}</li>
            <li><Link href={`${base}/fonti`}>{k.counts.sources} fonti</Link></li>
            <li><Link href={`${base}/affermazioni`}>{k.counts.assertions} affermazioni</Link></li>
            <li><Link href={`${base}/racconti`}>{k.counts.units} racconti</Link></li>
            <li><Link href={`${base}/percorsi`}>{k.counts.routes} percorsi</Link></li>
            <li><Link href={`${base}/media`}>{k.counts.media} foto</Link></li>
          </ul>
          <p className="st-hint">
            Ordine consigliato: luoghi → fonti → affermazioni (ogni fatto con la sua fonte) → racconti (legati alle affermazioni) →
            percorsi → foto e copertina.
          </p>
        </section>

        <section className="st-panel" aria-labelledby="pubblicazione">
          <h2 id="pubblicazione">Pubblicazione</h2>
          {!isDestination ? (
            <p className="st-hint">
              {KIND_LABELS[k.kind]}: è un contenitore. Non ha stato e non arriva all'app da sola: arrivano le destinazioni che ne
              fanno parte, con i suoi luoghi e le sue affermazioni.
            </p>
          ) : (
            <>
              <p className="st-hint">
                «Pubblicato» vuol dire approvato per la pubblicazione: il territorio arriva nell'app solo quando la pipeline di
                pubblicazione (prossima fase) ripete il controllo e compila i bundle. Finché è in bozza o in revisione non compare.
              </p>
              <div className="st-actions">
                <Link className="st-btn" href={`${base}/panoramica?controllo=1`}>Esegui il controllo di pubblicazione</Link>
                {k.status === "draft" && k.canEdit && statusForm("in_review", "Manda in revisione")}
                {k.status === "in_review" && k.canEdit && statusForm("draft", "Riporta in bozza")}
                {k.status === "in_review" && k.canPublish && statusForm("published", "Approva e pubblica", true)}
                {k.status === "published" && k.canPublish && statusForm("in_review", "Ritira la pubblicazione")}
              </div>
              {k.publications.length > 0 && (
                <p className="st-meta">
                  Ultima richiesta: {new Date(k.publications[0]!.createdAt).toLocaleString("it-IT")} · {k.publications[0]!.status}
                </p>
              )}
            </>
          )}
          {report && (
            <div aria-live="polite">
              <h3>{report.ok ? "Controllo superato" : `Controllo non superato: ${report.errors.length} errori`}</h3>
              {report.bundles.length > 0 && (
                <ul className="st-report">
                  {report.bundles.map((b) => (
                    <li key={b.locale}>
                      Bundle {b.locale}: {b.places} luoghi, {b.units} racconti, {b.assertions} affermazioni, {b.routes} percorsi
                      {b.preview ? " · anteprima" : ""}
                    </li>
                  ))}
                </ul>
              )}
              <ul className="st-report">
                {report.errors.map((e, i) => (
                  <li key={`e${i}`} className="st-e">
                    <strong>{e.code}</strong> {e.pack !== pack ? `(${e.pack}) ` : ""}{e.message}
                  </li>
                ))}
                {report.warnings.slice(0, 30).map((w, i) => (
                  <li key={`w${i}`} className="st-w">
                    <strong>{w.code}</strong> {w.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>

      <form action={updatePack} className="st-form">
        <input type="hidden" name="pack" value={pack} />
        <h2>Dati del territorio</h2>
        {ro && <p className="st-hint">Sola lettura: il tuo ruolo non modifica i dati di questo territorio.</p>}
        <fieldset disabled={ro}>
          <legend>Nome e descrizione</legend>
          {(["it", "en"] as const).map((l) => (
            <div key={l} className="st-row">
              <label>
                Nome ({l})
                <input name={`title_${l}`} defaultValue={k.title[l] ?? ""} maxLength={120} required={l === k.defaultLocale} />
              </label>
              <label>
                Descrizione ({l})
                <textarea name={`description_${l}`} rows={2} defaultValue={k.description[l] ?? ""} maxLength={1000} />
              </label>
            </div>
          ))}
        </fieldset>
        <fieldset disabled={ro}>
          <legend>Lingue, stadio e appartenenza</legend>
          <div className="st-row">
            <label>
              Lingua principale
              <select name="defaultLocale" defaultValue={k.defaultLocale}>
                <option value="it">Italiano</option>
                <option value="en">Inglese</option>
              </select>
            </label>
            <div className="st-checks" role="group" aria-label="Lingue supportate">
              {(["it", "en"] as const).map((l) => (
                <label key={l} className="st-inline">
                  <input type="checkbox" name="locales" value={l} defaultChecked={k.locales.includes(l)} /> {l === "it" ? "Italiano" : "Inglese"}
                </label>
              ))}
            </div>
            <label>
              Stadio
              <select name="releaseStage" defaultValue={k.releaseStage}>
                {Object.entries(STAGE_LABELS).map(([v, label]) => (
                  <option key={v} value={v}>{label}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Fa parte di (dipendenze)
            <select name="dependsOn" multiple size={Math.min(5, Math.max(2, candidates.length))} defaultValue={k.dependsOn}>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title.it ?? p.title.en ?? p.id} ({p.id})
                </option>
              ))}
            </select>
          </label>
          {isDestination && (
            <label>
              Immagine di copertina
              <select name="cover" defaultValue={k.cover ?? ""}>
                <option value="">— nessuna —</option>
                {k.coverCandidates.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
        {!ro && (
          <div className="st-actions">
            <button className="st-btn st-primary" type="submit">Salva i dati</button>
          </div>
        )}
      </form>

      {session.me.admin && (
        <p>
          <Link className="st-delete-link" href={deleteHref(pack, "pack")}>Elimina questo territorio…</Link>
        </p>
      )}
    </main>
  );
}
