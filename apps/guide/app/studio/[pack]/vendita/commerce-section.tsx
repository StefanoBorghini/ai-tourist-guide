import {
  formatEuro, TIER_LABELS, unitsWithoutProduct, type CatalogState, type CommerceState,
} from "../../../../lib/studio/catalog";
import { rpc, type StudioSession } from "../../../../lib/studio/server";
import { friendlyError } from "../../../../lib/studio/shared";
import { publishTiers, reviewDone, setAllProduct, setTierDraft, unitsOnSale } from "../../actions-commerce";
import { Notice } from "../../ui";

const euroInput = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");

/**
 * Acquisto progressivo (docs/v0.3-platform/ACQUISTO-PROGRESSIVO.md): listino centrale per livello, contenuti singoli,
 * «Tutte le destinazioni» e ordini da rivedere dopo un rimborso. Solo l'amministratore; le regole (prezzo con lo sconto,
 * minimo di 0,50 €, permessi) stanno nel database, migrazione 20261107000000_progressive_purchase.sql.
 */
export async function CommerceSection({ pack, session }: { pack: string; session: StudioSession }) {
  if (!session.me.admin) return null;
  const [res, cat] = await Promise.all([
    rpc<CommerceState>(session.supabase, "studio_commerce", {}),
    rpc<CatalogState>(session.supabase, "studio_catalog", { p_pack: pack }),
  ]);
  const c = res.data;
  // Senza la migrazione 20261107000000 la funzione non c'è: la sezione lo dice e il resto della pagina funziona.
  if (!c) {
    return (
      <section aria-labelledby="listino">
        <h2 id="listino" className="st-section-title">3. Listino e acquisto progressivo</h2>
        <Notice errore={res.error ? friendlyError(res.error) : "Listino non disponibile."} />
      </section>
    );
  }
  const catalog = cat.data;
  const drafts = c.tiers.filter((t) => t.draft).length;
  const toCreate = catalog && catalog.isDestination ? unitsWithoutProduct(catalog) : [];
  const unitProducts = (catalog?.products ?? []).filter((p) => p.kind === "unit" && p.status !== "retired").length;
  const all = c.all;

  return (
    <section aria-labelledby="listino">
      <h2 id="listino" className="st-section-title">3. Listino e acquisto progressivo</h2>
      <p className="st-hint">
        Un prezzo per ogni livello, uguale per tutte le destinazioni. Chi possiede già una parte di un livello paga solo la
        parte che manca: per esempio 2 contenuti su 4 di un luogo da 2,99 € → 1,50 €. Il prezzo non supera mai la somma dei
        singoli che mancano e lo sconto raggiunto non scende quando si aggiungono contenuti. Se il resto costa meno di
        0,50 € (il minimo di un pagamento) il pacchetto non si vende: si comprano i singoli. I percorsi restano fuori.
        Un prodotto con un proprio prezzo pubblicato lo tiene finché non scegli «Segui il listino» nella sua scheda.
      </p>

      <h3>Listino</h3>
      <ul className="st-assertions">
        {c.tiers.map((t) => (
          <li key={t.kind} className="st-assertion">
            <div className="st-assertion-head">
              <strong>{TIER_LABELS[t.kind]}</strong>
              <span className="st-status">
                Pubblicato: {t.published ? formatEuro(t.published.amount) : "nessuno"}
                {t.draft && ` · in bozza: ${formatEuro(t.draft.amount)}`}
              </span>
            </div>
            <div className="st-review">
              <form action={setTierDraft} className="st-reject">
                <input type="hidden" name="pack" value={pack} />
                <input type="hidden" name="kind" value={t.kind} />
                <input name="price" inputMode="decimal" required aria-label={`Tariffa in bozza: ${TIER_LABELS[t.kind]}, in euro`}
                  defaultValue={t.draft ? euroInput(t.draft.amount) : t.published ? euroInput(t.published.amount) : ""} />
                <button className="st-btn" type="submit">Tariffa in bozza</button>
              </form>
              {t.draft && (
                <form action={setTierDraft}>
                  <input type="hidden" name="pack" value={pack} />
                  <input type="hidden" name="kind" value={t.kind} />
                  <input type="hidden" name="clear" value="1" />
                  <button className="st-btn" type="submit">Togli la bozza</button>
                </form>
              )}
            </div>
          </li>
        ))}
      </ul>
      <form action={publishTiers} className="st-review">
        <input type="hidden" name="pack" value={pack} />
        <button className="st-btn" type="submit" disabled={drafts === 0}>
          Pubblica il listino{drafts > 0 ? ` (${drafts} in bozza)` : ""}
        </button>
        {drafts === 0 && <span className="st-hint">Nessuna tariffa in bozza.</span>}
      </form>

      {catalog?.isDestination && catalog.explore === "premium" && (
        <div className="st-review" aria-labelledby="contenuti-singoli">
          <h3 id="contenuti-singoli">Contenuti singoli</h3>
          <p className="st-hint">
            Ogni sottoluogo con racconti si può comprare anche da solo, al prezzo di listino del contenuto singolo. Un
            luogo principale si compra solo intero, con i suoi sottoluoghi (i suoi racconti contano per lo sconto). In questa destinazione i contenuti a
            pagamento sono <strong>{catalog.units ?? 0}</strong>; in vendita da soli: <strong>{unitProducts}</strong>.
            Se il luogo ha un solo contenuto il sottoluogo non si vende da solo: si vende il luogo, allo stesso prezzo del singolo.
            {toCreate.length > 0 && ` ${toCreate.length} contenuti non hanno ancora il loro prodotto.`}
            {" "}Dopo averli creati, in Panoramica «Ripubblica con le modifiche» perché l&apos;app riceva i loro file.
          </p>
          {toCreate.length > 0 && (
            <ul className="st-meta">
              {toCreate.map((pl) => <li key={pl.slug}>{pl.name}{pl.parent ? ` · fa parte di ${pl.parent}` : ""}</li>)}
            </ul>
          )}
          <form action={unitsOnSale}>
            <input type="hidden" name="pack" value={pack} />
            <button className="st-btn" type="submit">Metti in vendita i contenuti singoli</button>
          </form>
        </div>
      )}

      <div className="st-review" aria-labelledby="tutte">
        <h3 id="tutte">Tutte le destinazioni</h3>
        <p className="st-hint">
          Un solo acquisto per ogni luogo di tutte le destinazioni con l&apos;esplorazione a pagamento, anche quelle
          pubblicate dopo. Destinazioni ora: <strong>{all.destinations.join(", ") || "nessuna"}</strong> · contenuti:{" "}
          <strong>{all.units}</strong>.
          {all.product ? ` Stato: ${all.product.status === "active" ? "in vendita" : "non in vendita"}.` : " Il prodotto non esiste ancora."}
          {all.product && all.product.paidOrders > 0 && ` Acquisti: ${all.product.paidOrders}.`}
        </p>
        {all.problem && <p className="st-notice st-warn" role="note">Non vendibile: {all.problem}.</p>}
        <form action={setAllProduct}>
          <input type="hidden" name="pack" value={pack} />
          <input type="hidden" name="active" value={all.product?.status === "active" ? "0" : "1"} />
          <button className="st-btn" type="submit" disabled={all.product?.status !== "active" && all.problem !== null}>
            {all.product?.status === "active" ? "Togli dalla vendita" : "Metti in vendita"}
          </button>
        </form>
      </div>

      <div className="st-review" aria-labelledby="da-rivedere">
        <h3 id="da-rivedere">Ordini da rivedere</h3>
        <p className="st-hint">
          Quando si rimborsa un acquisto che aveva ridotto il prezzo di un acquisto successivo, quest&apos;ultimo compare qui.
          Nessuna revoca automatica: decidi tu, in Stripe, se chiedere la differenza o lasciare com&apos;è.
        </p>
        {c.reviews.length === 0 && <p className="st-hint">Nessun ordine da rivedere.</p>}
        <ul className="st-assertions">
          {c.reviews.map((r) => (
            <li key={r.id} className="st-assertion">
              <div className="st-assertion-head">
                <strong>{r.product}</strong>
                <span className="st-status">
                  Pagato {formatEuro(r.amount)}{r.list ? ` (listino ${formatEuro(r.list)})` : ""} · {r.status}
                </span>
              </div>
              <p className="st-notes">{r.reason}. Ordine <code>{r.id}</code>.</p>
              <form action={reviewDone}>
                <input type="hidden" name="pack" value={pack} />
                <input type="hidden" name="order" value={r.id} />
                <button className="st-btn" type="submit">Rivisto</button>
              </form>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
