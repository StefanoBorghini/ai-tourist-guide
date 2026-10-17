import { rpc, type StudioSession } from "../../../../lib/studio/server";
import { friendlyError } from "../../../../lib/studio/shared";
import { Notice } from "../../ui";
import { setAccess } from "../../actions";

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
export async function AccessSection({ pack, session }: { pack: string; session: StudioSession }) {
  const { data, error } = await rpc<AccessState>(session.supabase, "studio_access", { p_pack: pack });
  const a = data;
  const intro = new Set(a?.introPlaces ?? []);
  const premiumRoutes = new Set(a?.premiumRoutes ?? []);
  const missingOpenings = (p: AccessState["places"][number]) => (a?.locales ?? []).filter((l) => !p.openings.includes(l));
  const editable = Boolean(a?.canEdit && a.isDestination);

  return (
    <section aria-labelledby="accesso">
      <h2 id="accesso" className="st-section-title">1. Cosa è a pagamento</h2>
      {error && <Notice errore={friendlyError(error)} />}
      <p className="st-hint">
        Gratuiti restano sempre la mappa, l&apos;elenco dei luoghi e i percorsi gratuiti. Con l&apos;esplorazione a
        pagamento sono gratuiti anche i racconti d&apos;apertura dei luoghi introduttivi (al massimo 3); gli altri racconti,
        e i fatti che citano, non entrano nell&apos;app pubblica. Un percorso a pagamento non entra nell&apos;app pubblica in nessun caso.
      </p>
      <p className="st-notice st-warn" role="note">
        Ciò che segni come a pagamento esce dall&apos;app pubblica alla prossima «Ripubblica»: lo vede solo chi lo ha
        acquistato. Prima di ripubblicare, prepara qui sotto il prodotto con il suo prezzo.
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
            <legend>Percorsi a pagamento</legend>
            {a.routes.length === 0 && <p className="st-hint">Nessun percorso.</p>}
            {a.routes.map((r) => (
              <label key={r.slug} className="st-inline">
                <input type="checkbox" name="premiumRoutes" value={r.slug} defaultChecked={premiumRoutes.has(r.slug)} /> {r.name} ({r.durationMin} min)
              </label>
            ))}
          </fieldset>
          {editable && <button className="st-btn" type="submit">Salva cosa è a pagamento</button>}
        </form>
      )}
    </section>
  );
}
