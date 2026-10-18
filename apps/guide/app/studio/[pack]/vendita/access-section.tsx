import { premiumBlockedByStatic } from "../../../../lib/static-bundles";
import { staticDestinations } from "../../../../lib/static-index";
import { rpc, type StudioSession } from "../../../../lib/studio/server";
import { friendlyError } from "../../../../lib/studio/shared";
import { Notice } from "../../ui";
import { setAccess } from "../../actions";

interface AccessState {
  explore: "free" | "premium";
  introPlaces: string[];
  freePlaces?: string[];
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
  const free = new Set(a?.freePlaces ?? []);
  const placeChoice = (slug: string) => (free.has(slug) ? "free" : intro.has(slug) ? "intro" : "paid");
  const premiumRoutes = new Set(a?.premiumRoutes ?? []);
  const missingOpenings = (p: AccessState["places"][number]) => (a?.locales ?? []).filter((l) => !p.openings.includes(l));
  const editable = Boolean(a?.canEdit && a.isDestination);
  // Destinazione distribuita anche dai file dell'app: lo si dice subito, invece di rifiutare al salvataggio.
  const staticBlock = a?.isDestination ? premiumBlockedByStatic(pack, await staticDestinations()) : null;

  return (
    <section aria-labelledby="accesso">
      <h2 id="accesso" className="st-section-title">1. Cosa è a pagamento</h2>
      {error && <Notice errore={friendlyError(error)} />}
      {staticBlock && (
        <div className="st-notice st-warn" role="note">
          <strong>Per ora questa destinazione non può avere contenuti a pagamento.</strong> Una sua copia completa è
          dentro l&apos;app stessa (i file con cui l&apos;app viene costruita), quindi chiunque la scaricherebbe gratis.
          Per venderla serve togliere la copia dall&apos;app: dopo, l&apos;app riceve la destinazione solo dallo Studio,
          quindi deve essere pubblicata dallo Studio con il controllo superato. È una modifica al codice: chiedila
          allo sviluppatore.
        </div>
      )}
      <p className="st-hint">
        Gratuiti restano sempre la mappa, l&apos;elenco dei luoghi e i percorsi gratuiti. Con l&apos;esplorazione a
        pagamento ogni luogo può essere: <strong>a pagamento</strong>{" "}(si sblocca con l&apos;esplorazione completa o comprandolo da
        solo), <strong>introduttivo</strong>{" "}(gratuito il racconto d&apos;apertura, al massimo 3 luoghi) o <strong>gratuito</strong>{" "}(tutti i
        suoi racconti nell&apos;app pubblica, non si vende). I racconti a pagamento, e i fatti che citano, non entrano
        nell&apos;app pubblica. Un percorso a pagamento non entra nell&apos;app pubblica in nessun caso.
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
              <input type="radio" name="explore" value="premium" defaultChecked={a.explore === "premium"} disabled={Boolean(staticBlock) && a.explore !== "premium"} /> A pagamento: gratuiti solo
              i luoghi gratuiti e i racconti d&apos;apertura dei luoghi introduttivi
            </label>
          </fieldset>
          <fieldset disabled={!editable}>
            <legend>Luoghi (con l&apos;esplorazione a pagamento)</legend>
            {a.places.length === 0 && <p className="st-hint">Nessun luogo.</p>}
            {a.places.map((p) => {
              const missing = missingOpenings(p);
              return (
                <label key={p.slug} className="st-row st-place-access">
                  <span>{p.name}</span>
                  <select name={`place:${p.slug}`} defaultValue={placeChoice(p.slug)} aria-label={`Accesso a ${p.name}`}>
                    <option value="paid">A pagamento</option>
                    <option value="intro">Introduttivo: apertura gratis</option>
                    <option value="free">Gratuito: tutti i racconti</option>
                  </select>
                  {intro.has(p.slug) && missing.length > 0 && <span className="st-hint">manca il racconto d&apos;apertura in {missing.join(", ")}</span>}
                </label>
              );
            })}
          </fieldset>
          <fieldset disabled={!editable}>
            <legend>Percorsi a pagamento</legend>
            {a.routes.length === 0 && <p className="st-hint">Nessun percorso.</p>}
            {a.routes.map((r) => (
              <label key={r.slug} className="st-inline">
                <input type="checkbox" name="premiumRoutes" value={r.slug} defaultChecked={premiumRoutes.has(r.slug)} disabled={Boolean(staticBlock) && !premiumRoutes.has(r.slug)} /> {r.name} ({r.durationMin} min)
              </label>
            ))}
          </fieldset>
          {editable && <button className="st-btn" type="submit">Salva cosa è a pagamento</button>}
        </form>
      )}
    </section>
  );
}
