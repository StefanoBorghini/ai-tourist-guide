import {
  AVAILABILITY_LABELS, formatEuro, onSale, PRODUCT_KIND_LABELS, PRODUCT_STATUS_LABELS, type CatalogProduct, type CatalogState,
} from "../../../../lib/studio/catalog";
import { rpc, type StudioSession } from "../../../../lib/studio/server";
import { friendlyError } from "../../../../lib/studio/shared";
import { publishPrices, saveProduct, setDraftPrice } from "../../actions";
import { Notice } from "../../ui";

/**
 * Catalogo di una destinazione: prodotti (esplorazione, percorsi premium, pacchetti) e prezzi in bozza o pubblicati.
 * Solo l'amministratore della piattaforma; le regole stanno nel database (supabase/migrations/20261025000000_catalog.sql):
 * un prodotto si attiva solo se il contenuto è davvero a pagamento nell'Accesso, un prezzo pubblicato non si modifica
 * (se ne pubblica uno nuovo e il vecchio resta nello storico). Gli acquisti arriveranno con Stripe.
 */
export async function CatalogSection({ pack, session }: { pack: string; session: StudioSession }) {
  const res = session.me.admin ? await rpc<CatalogState>(session.supabase, "studio_catalog", { p_pack: pack }) : null;
  const c = res?.data ?? null;
  const error = res?.error ?? null;
  const routeName = new Map((c?.routes ?? []).map((r) => [r.slug, r.name]));
  const hasExplore = (c?.products ?? []).some((p) => p.kind === "explore" && p.status !== "retired");
  const routesWithProduct = new Set((c?.products ?? []).filter((p) => p.kind === "route" && p.status !== "retired").map((p) => p.route?.slug));
  const freeRoutes = (c?.routes ?? []).filter((r) => !routesWithProduct.has(r.slug));

  return (
    <section aria-labelledby="prezzi">
      <h2 id="prezzi" className="st-section-title">2. Prodotti e prezzi</h2>
      {error && <Notice errore={friendlyError(error)} />}
      {!session.me.admin && <p className="st-hint">Prodotti e prezzi li gestisce l&apos;amministratore della piattaforma.</p>}
      {session.me.admin && (
        <p className="st-hint">
          Un prodotto è ciò che il visitatore compra (l&apos;esplorazione completa, un percorso, un pacchetto di percorsi).
          Si attiva solo se il contenuto è a pagamento al punto 1. Il prezzo si scrive in bozza e vale dopo «Pubblica i
          prezzi»; un prezzo pubblicato non si cambia: se ne pubblica uno nuovo e il precedente resta nello storico.
          Gli acquisti per ora sono in modalità di prova (Stripe test): nessun pagamento reale.
        </p>
      )}
      {session.me.admin && !c && !error && <p className="st-hint">Territorio non trovato.</p>}
      {c && !c.isDestination && <p className="st-hint">Si vendono solo le destinazioni.</p>}
      {c && c.isDestination && (
        <>
          <p className="st-hint">
            Esplorazione: <strong>{c.explore === "premium" ? "a pagamento" : "gratuita"}</strong>. Percorsi a pagamento:{" "}
            <strong>{c.routes.filter((r) => r.premium).map((r) => r.name).join(", ") || "nessuno"}</strong>.
          </p>

          <form action={publishPrices} className="st-review">
            <input type="hidden" name="pack" value={pack} />
            <button className="st-btn" type="submit" disabled={c.drafts === 0}>
              Pubblica i prezzi{c.drafts > 0 ? ` (${c.drafts} in bozza)` : ""}
            </button>
            {c.drafts === 0 && <span className="st-hint">Nessun prezzo in bozza.</span>}
          </form>

          <h3>Prodotti</h3>
          {c.products.length === 0 && <p className="st-hint">Nessun prodotto.</p>}
          <ul className="st-assertions">
            {c.products.map((p) => (
              <ProductCard key={p.id} pack={pack} p={p} routes={c.routes} routeName={routeName} />
            ))}
          </ul>

          <details className="st-create" open={c.products.length === 0}>
            <summary>Nuovo prodotto</summary>
            <form action={saveProduct} className="st-form">
              <input type="hidden" name="pack" value={pack} />
              <label>
                Tipo
                <select name="kind" defaultValue={hasExplore ? "route" : "explore"} required>
                  <option value="explore" disabled={hasExplore}>Esplorazione{hasExplore ? " (esiste già)" : ""}</option>
                  <option value="route" disabled={freeRoutes.length === 0}>Percorso</option>
                  <option value="bundle">Pacchetto di percorsi</option>
                </select>
              </label>
              <label>
                Percorso (solo per il tipo «Percorso»)
                <select name="route" defaultValue="">
                  <option value="">—</option>
                  {freeRoutes.map((r) => (
                    <option key={r.slug} value={r.slug}>{r.name}{r.premium ? "" : " (gratuito)"}</option>
                  ))}
                </select>
              </label>
              <ProductFields routes={c.routes} />
              <button className="st-btn" type="submit">Crea in bozza</button>
            </form>
          </details>
        </>
      )}
    </section>
  );
}

function ProductCard({ pack, p, routes, routeName }: {
  pack: string; p: CatalogProduct; routes: CatalogState["routes"]; routeName: Map<string, string>;
}) {
  const name = p.labels.it?.name ?? p.slug;
  const what = p.kind === "route" && p.route ? `: ${routeName.get(p.route.slug) ?? p.route.slug}`
    : p.kind === "bundle" ? `: ${p.routes.map((r) => routeName.get(r) ?? r).join(", ") || "nessun percorso"}` : "";
  const retired = p.status === "retired";
  return (
    <li className="st-assertion">
      <div className="st-assertion-head">
        <strong>{name}</strong>
        <span className="st-status">{PRODUCT_KIND_LABELS[p.kind]}{what}</span>
        <span className={`st-status ${p.status === "active" ? "st-verified" : p.status === "draft" ? "st-draft" : ""}`}>
          {PRODUCT_STATUS_LABELS[p.status]}
        </span>
        {p.availability !== "available" && <span className="st-status">{AVAILABILITY_LABELS[p.availability]}</span>}
        {onSale(p) && <span className="st-status st-verified">Nel listino pubblico</span>}
      </div>
      <p className="st-notes">
        {retired ? "Ultimo prezzo pubblicato" : "Prezzo pubblicato"}: <strong>{p.published ? formatEuro(p.published.amount) : "nessuno"}</strong>
        {p.draft && <> · in bozza: <strong>{formatEuro(p.draft.amount)}</strong></>}
        {p.paidOrders > 0 && <> · acquisti: {p.paidOrders}</>}
      </p>
      {p.problem && <p className="st-notice st-warn" role="note">Non vendibile: {p.problem}.</p>}
      {!retired && (
        <div className="st-review">
          <form action={setDraftPrice} className="st-reject">
            <input type="hidden" name="pack" value={pack} />
            <input type="hidden" name="product" value={p.id} />
            <input name="price" inputMode="decimal" placeholder="es. 4,99" aria-label={`Prezzo in bozza per ${name}, in euro`}
              defaultValue={p.draft ? (p.draft.amount / 100).toFixed(2).replace(".", ",") : ""} required />
            <button className="st-btn" type="submit">Prezzo in bozza</button>
          </form>
          {p.draft && (
            <form action={setDraftPrice}>
              <input type="hidden" name="pack" value={pack} />
              <input type="hidden" name="product" value={p.id} />
              <input type="hidden" name="clear" value="1" />
              <button className="st-btn" type="submit">Togli la bozza</button>
            </form>
          )}
        </div>
      )}
      <details>
        <summary>Modifica il prodotto</summary>
        <form action={saveProduct} className="st-form">
          <input type="hidden" name="pack" value={pack} />
          <input type="hidden" name="id" value={p.id} />
          <ProductFields routes={routes} p={p} />
          <button className="st-btn" type="submit">Salva il prodotto</button>
        </form>
      </details>
    </li>
  );
}

/** Campi comuni a creazione e modifica. I percorsi del pacchetto compaiono solo per i pacchetti (o in creazione). */
function ProductFields({ routes, p }: { routes: CatalogState["routes"]; p?: CatalogProduct }) {
  const inBundle = new Set(p?.routes ?? []);
  const retired = p?.status === "retired";
  return (
    <>
      <div className="st-row">
        <label>Nome (italiano)<input name="name_it" defaultValue={p?.labels.it?.name ?? ""} maxLength={80} required /></label>
        <label>Nome (inglese)<input name="name_en" defaultValue={p?.labels.en?.name ?? ""} maxLength={80} /></label>
      </div>
      <div className="st-row">
        <label>Descrizione (italiano)<textarea name="description_it" defaultValue={p?.labels.it?.description ?? ""} maxLength={500} rows={2} /></label>
        <label>Descrizione (inglese)<textarea name="description_en" defaultValue={p?.labels.en?.description ?? ""} maxLength={500} rows={2} /></label>
      </div>
      <div className="st-row">
        <label>
          Stato
          <select name="status" defaultValue={p?.status ?? "draft"}>
            <option value="draft" disabled={retired}>{PRODUCT_STATUS_LABELS.draft}</option>
            <option value="active" disabled={retired}>{PRODUCT_STATUS_LABELS.active}</option>
            <option value="retired">{PRODUCT_STATUS_LABELS.retired}</option>
          </select>
        </label>
        <label>
          Disponibilità
          <select name="availability" defaultValue={p?.availability ?? "available"}>
            {Object.entries(AVAILABILITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label>Ordine<input name="sort_order" type="number" min={0} max={999} defaultValue={p?.sortOrder ?? 0} /></label>
      </div>
      {(!p || p.kind === "bundle") && (
        <fieldset>
          <legend>Percorsi del pacchetto{p ? "" : " (solo per il tipo «Pacchetto»)"}</legend>
          {p && <input type="hidden" name="bundle" value="1" />}
          {routes.length === 0 && <p className="st-hint">Nessun percorso.</p>}
          {routes.map((r) => (
            <label key={r.slug} className="st-inline">
              <input type="checkbox" name="routes" value={r.slug} defaultChecked={inBundle.has(r.slug)} /> {r.name}
              {!r.premium && <span className="st-hint"> (gratuito)</span>}
            </label>
          ))}
        </fieldset>
      )}
    </>
  );
}
