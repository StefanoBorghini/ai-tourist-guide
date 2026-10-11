import { requireStaff, rpc } from "../../../../lib/studio/server";
import { friendlyError } from "../../../../lib/studio/shared";
import { setAccess } from "../../actions";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../ui";

interface AccessState {
  explore: "free" | "premium";
  introPlaces: string[];
  premiumRoutes: string[];
  isDestination: boolean;
  places: { slug: string; name: string; openings: string[] }[];
  routes: { slug: string; name: string; durationMin: number }[];
  locales: string[];
  canEdit: boolean;
}

/**
 * Contenuti a pagamento di una destinazione (decisione D1): esplorazione completa e percorsi premium.
 * Li decide solo l'amministratore della piattaforma; gli altri vedono la situazione senza poterla cambiare.
 */
export default async function AccessPage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const { data, error } = await rpc<AccessState>(session.supabase, "studio_access", { p_pack: pack });
  const a = data;
  const intro = new Set(a?.introPlaces ?? []);
  const premiumRoutes = new Set(a?.premiumRoutes ?? []);
  const missingOpenings = (p: AccessState["places"][number]) => (a?.locales ?? []).filter((l) => !p.openings.includes(l));
  const editable = Boolean(a?.canEdit && a.isDestination);

  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ label: pack }]} />
      <PackTabs pack={pack} current="accesso" />
      <h1>Accesso</h1>
      <Notice ok={one(q.ok)} errore={one(q.errore) ?? (error ? friendlyError(error) : undefined)} />
      <p className="st-hint">
        Gratuiti restano sempre la mappa, l&apos;elenco dei luoghi e i percorsi non premium. Con l&apos;esplorazione a
        pagamento sono gratuiti anche i racconti d&apos;apertura dei luoghi introduttivi (al massimo 3); gli altri racconti,
        e i fatti che citano, non entrano nell&apos;app pubblica. Un percorso premium non entra nell&apos;app pubblica in nessun caso.
      </p>
      <p className="st-notice st-warn" role="note">
        Prezzi e acquisti non ci sono ancora: ciò che segni come a pagamento, dalla prossima pubblicazione, non sarà
        visibile a nessuno nell&apos;app. Le modifiche valgono solo dopo «Ripubblica».
      </p>
      {!a && !error && <p className="st-hint">Territorio non trovato o fuori dal tuo ambito.</p>}
      {a && !a.isDestination && <p className="st-hint">L&apos;accesso a pagamento si configura solo sulle destinazioni.</p>}
      {a && a.isDestination && !a.canEdit && (
        <p className="st-hint">Lo decide l&apos;amministratore della piattaforma. Situazione attuale qui sotto.</p>
      )}
      {a && a.isDestination && (
        <form action={setAccess} className="st-form">
          <input type="hidden" name="pack" value={pack} />
          <fieldset disabled={!editable}>
            <legend>Esplorazione libera</legend>
            <label className="st-inline">
              <input type="radio" name="explore" value="free" defaultChecked={a.explore !== "premium"} /> Gratuita: tutti i racconti
              sono nell&apos;app pubblica
            </label>
            <label className="st-inline">
              <input type="radio" name="explore" value="premium" defaultChecked={a.explore === "premium"} /> A pagamento: gratuiti solo
              i racconti d&apos;apertura dei luoghi introduttivi
            </label>
          </fieldset>
          <fieldset disabled={!editable}>
            <legend>Luoghi introduttivi (al massimo 3)</legend>
            {a.places.length === 0 && <p className="st-hint">Nessun luogo.</p>}
            {a.places.map((p) => {
              const missing = missingOpenings(p);
              return (
                <label key={p.slug} className="st-inline">
                  <input type="checkbox" name="introPlaces" value={p.slug} defaultChecked={intro.has(p.slug)} /> {p.name}
                  {missing.length > 0 && <span className="st-hint"> — manca il racconto d&apos;apertura in {missing.join(", ")}</span>}
                </label>
              );
            })}
          </fieldset>
          <fieldset disabled={!editable}>
            <legend>Percorsi premium</legend>
            {a.routes.length === 0 && <p className="st-hint">Nessun percorso.</p>}
            {a.routes.map((r) => (
              <label key={r.slug} className="st-inline">
                <input type="checkbox" name="premiumRoutes" value={r.slug} defaultChecked={premiumRoutes.has(r.slug)} /> {r.name} ({r.durationMin} min)
              </label>
            ))}
          </fieldset>
          {editable && <button className="st-btn" type="submit">Salva l&apos;accesso</button>}
        </form>
      )}
    </main>
  );
}
