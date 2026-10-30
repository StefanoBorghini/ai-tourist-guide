import Link from "next/link";
import { checkReadiness, requireStaff, rpc } from "../../../../lib/studio/server";
import { explainIssues } from "../../../../lib/studio/explain";
import type { ReadinessReport } from "../../../../lib/studio/readiness";
import { deleteHref, friendlyError } from "../../../../lib/studio/shared";
import { republishPack, setPackStatus, updatePack } from "../../actions";
import { KIND_LABELS, Notice, one, PackStatus, PackTabs, STAGE_LABELS, StudioHeader, type SearchParams } from "../../ui";
import { formatStudioTime } from "../../../../lib/format";

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
  publications: {
    status: string;
    createdAt: string;
    report: {
      ok?: boolean;
      pipeline?: { errors?: string[]; warnings?: string[]; bundles?: { locale: string; totalBytes: number; places: number; units: number }[] };
    } | null;
  }[];
  counts: Record<string, number>;
  canEdit: boolean;
  canPublish: boolean;
}

// La pubblicazione compila e carica i bundle (e i media) in questa richiesta: con un territorio grande 60 s non bastavano
// (timeout su Vercel, ottobre 2026). 300 s è il massimo con Fluid compute anche sul piano Hobby.
export const maxDuration = 300;

export default async function OverviewPage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const [{ data: k, error }, all, events, businesses] = await Promise.all([
    rpc<PackDetail>(session.supabase, "studio_pack", { p_pack: pack }),
    rpc<{ id: string; kind: string; title: Record<string, string> }[]>(session.supabase, "studio_packs"),
    // Dati operativi (fuori dal pack): solo chi può modificare il territorio li vede; altrimenti la riga non compare.
    rpc<{ publication: string; endsAt: string }[]>(session.supabase, "studio_local_events", { p_pack: pack }),
    rpc<{ publication: string }[]>(session.supabase, "studio_local_businesses", { p_pack: pack }),
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
  const live = k.publications.find((p) => p.status === "published");
  const lastFailed = k.publications[0]?.status === "failed" ? k.publications[0] : undefined;
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
            <li><Link href={`${base}/affermazioni`}>{k.counts.assertions} fatti</Link> (ogni fatto con la sua fonte)</li>
            <li><Link href={`${base}/racconti`}>{k.counts.units} racconti</Link></li>
            <li><Link href={`${base}/percorsi`}>{k.counts.routes} percorsi</Link></li>
            <li><Link href={`${base}/media`}>{k.counts.media} foto</Link></li>
            {k.kind === "destination" && k.canEdit && events.data && (
              <li>
                <Link href={`${base}/eventi`}>{events.data.length} eventi</Link>
                {` · ${events.data.filter((e) => e.publication === "published" && Date.parse(e.endsAt) > Date.now()).length} pubblicati in arrivo`}
              </li>
            )}
            {k.kind === "destination" && k.canEdit && businesses.data && (
              <li>
                <Link href={`${base}/attivita`}>{businesses.data.length} attività</Link>
                {` · ${businesses.data.filter((b) => b.publication === "published").length} pubblicate`}
                {" · "}<Link href={`${base}/attivita/nuova`}>aggiungi</Link>
              </li>
            )}
          </ul>
          <p className="st-hint">
            Ordine consigliato: luoghi → fonti → fatti (ognuno con la sua fonte) → racconti (costruiti sui fatti) →
            percorsi → foto e copertina. Eventi e attività sono a parte: si pubblicano da soli, senza ripubblicare il territorio.
          </p>
        </section>

        <section className="st-panel" aria-labelledby="pubblicazione">
          <h2 id="pubblicazione">Pubblicazione</h2>
          {!isDestination ? (
            <p className="st-hint">
              {KIND_LABELS[k.kind]}: è un contenitore. Non ha stato e non arriva all'app da sola: arrivano le destinazioni che ne
              fanno parte, con i suoi luoghi e i suoi fatti.
            </p>
          ) : (
            <>
              <ol className="st-steps">
                <li className={k.status !== "draft" ? "st-done" : undefined}><strong>Controlla se è pronto</strong>: lo Studio dice cosa manca, in parole semplici.</li>
                <li className={k.status === "in_review" || k.status === "published" ? "st-done" : undefined}><strong>Manda in revisione</strong> quando il controllo è superato.</li>
                <li className={k.status === "published" ? "st-done" : undefined}><strong>Approva e pubblica</strong>: il territorio arriva subito nell&apos;app, senza aggiornarla.</li>
              </ol>
              <p className="st-hint">Le modifiche fatte dopo arrivano nell&apos;app solo con «Ripubblica con le modifiche».</p>
              {live ? (
                <p className="st-live">
                  <strong>Nell'app</strong> dal {formatStudioTime(live.createdAt)}
                  {live.report?.pipeline?.bundles?.length
                    ? ` · ${live.report.pipeline.bundles.map((b) => `${b.locale}: ${b.places} luoghi, ${b.units} racconti, ${(b.totalBytes / 1024 / 1024).toFixed(1)} MB`).join(" · ")}`
                    : ""}
                  {k.status !== "published" ? " · ritirato: non compare più" : ""}
                </p>
              ) : (
                <p className="st-meta">Non ancora nell'app.</p>
              )}
              {lastFailed && (
                <div className="st-notice st-error">
                  Ultima pubblicazione non riuscita ({formatStudioTime(lastFailed.createdAt)}):{" "}
                  {(lastFailed.report?.pipeline?.errors ?? []).slice(0, 5).join("; ") || "errore sconosciuto"}
                </div>
              )}
              <div className="st-actions">
                <Link className="st-btn" href={`${base}/panoramica?controllo=1#controllo`}>Controlla se è pronto</Link>
                {k.status === "draft" && k.canEdit && statusForm("in_review", "Manda in revisione")}
                {k.status === "in_review" && k.canEdit && statusForm("draft", "Riporta in bozza")}
                {k.status === "in_review" && k.canPublish && statusForm("published", "Approva e pubblica", true)}
                {k.status === "published" && k.canPublish && (
                  <form action={republishPack}>
                    <input type="hidden" name="pack" value={pack} />
                    <button className="st-btn st-primary" type="submit">Ripubblica con le modifiche</button>
                  </form>
                )}
                {k.status === "published" && k.canPublish && statusForm("in_review", "Ritira dall'app")}
              </div>
            </>
          )}
          {report && <ReadinessView report={report} pack={pack} base={base} />}
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

/** Esito del controllo: prima cosa blocca la pubblicazione, poi cosa migliorare; il dettaglio tecnico resta a richiesta. */
function ReadinessView({ report, pack, base }: { report: ReadinessReport; pack: string; base: string }) {
  const errors = explainIssues(report.errors, pack);
  const warnings = explainIssues(report.warnings, pack);
  const item = (g: ReturnType<typeof explainIssues>[number]) => (
    <li key={`${g.level}${g.code}`} className={g.level === "error" ? "st-e" : "st-w"}>
      <strong>{g.title}</strong>
      <span className="st-todo">{g.todo}</span>
      {g.fix && <Link className="st-btn st-small" href={`${base}/${g.fix.tab}`}>{g.fix.label}</Link>}
      {/* Pochi casi: si vedono subito (dicono quale elemento); molti: a richiesta. */}
      {g.details.length <= 3 ? (
        <ul className="st-detail">{g.details.map((d, i) => <li key={i}>{d}</li>)}<li className="st-code">{g.code}</li></ul>
      ) : (
        <details>
          <summary>Quali sono ({g.details.length}) · {g.code}</summary>
          <ul>{g.details.slice(0, 50).map((d, i) => <li key={i}>{d}</li>)}</ul>
          {g.details.length > 50 && <p className="st-hint">… e altri {g.details.length - 50}.</p>}
        </details>
      )}
    </li>
  );
  return (
    <div id="controllo" aria-live="polite" className="st-check">
      <h3>{report.ok ? "✓ Pronto per la pubblicazione" : `Prima di pubblicare: ${errors.length === 1 ? "una cosa da sistemare" : `${errors.length} cose da sistemare`}`}</h3>
      {report.bundles.length > 0 && (
        <p className="st-hint">
          Nell&apos;app arriverebbero:{" "}
          {report.bundles.map((b) => `${b.locale === "it" ? "italiano" : b.locale === "en" ? "inglese" : b.locale} ${b.places} luoghi, ${b.units} racconti, ${b.routes} percorsi`).join(" · ")}
          {report.bundles.some((b) => b.preview) ? " (anteprima: anche fatti in revisione, segnalati ai visitatori)" : ""}.
        </p>
      )}
      {errors.length > 0 && <ul className="st-checklist">{errors.map(item)}</ul>}
      {warnings.length > 0 && (
        <details className="st-warnings">
          <summary>Da migliorare, ma non bloccano: {warnings.length === 1 ? "un punto" : `${warnings.length} punti`}</summary>
          <ul className="st-checklist">{warnings.map(item)}</ul>
        </details>
      )}
    </div>
  );
}
