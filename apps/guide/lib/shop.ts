/**
 * Vendita nell'app: abbina i contenuti a pagamento di un bundle (content.locked) ai prodotti del listino pubblico
 * (public_catalog, letto da /api/catalog). Puro (test in test/shop.test.ts). Il prezzo mostrato è solo informativo:
 * l'importo addebitato lo decide il server al checkout.
 *
 * Acquisto progressivo (migrazione 20261107000000): con un account, /api/catalog aggiunge il preventivo personale di
 * ogni prodotto (my_commerce_quotes). Un livello superiore costa meno quanto più se ne possiede già; ciò che si ha già
 * non si offre; sotto 0,50 € non si vende (si comprano i singoli che mancano).
 */
import type { BundleContent } from "@guide/bundle/client";

type BundleLocked = NonNullable<BundleContent["locked"]>;

export interface CatalogItem {
  id: string;
  kind: "explore" | "route" | "bundle" | "place" | "unit" | "all";
  labels: Record<string, { name?: string; description?: string } | undefined>;
  route?: string | null;
  /** Luogo (slug), per i prodotti «place» (migrazione 20261028000000) e «unit» (contenuto singolo). */
  place?: string | null;
  /** Luogo principale (slug) di un contenuto singolo che è un sottoluogo. */
  principal?: string | null;
  /** Contenuti a pagamento del livello («place», «explore», «all»). */
  units?: number | null;
  routes?: string[];
  price: { amount: number; currency: string };
  available: boolean;
}

/** Preventivo personale (commerce_quote): esito, listino, prezzo per l'utente, contenuti posseduti sul totale. */
export interface Quote {
  product: string;
  kind: CatalogItem["kind"];
  status: "ok" | "unpriced" | "owned" | "complete" | "below_minimum";
  list: number | null;
  amount: number | null;
  total: number;
  owned: number;
}

export interface Offer {
  productId: string;
  name: string;
  amount: number;
  /** Pacchetto di più percorsi (lo si dice, perché il prezzo vale per tutti). */
  bundle: boolean;
  /** Prezzo di listino, solo se l'utente paga meno (sconto per i contenuti che possiede già). */
  list?: number;
  /** Contenuti del livello già posseduti, sul totale (solo con lo sconto). */
  progress?: { owned: number; total: number };
  /** Resta meno del minimo di un pagamento (0,50 €): il pacchetto non si compra, si comprano i singoli. */
  belowMinimum?: true;
}

export interface Offers {
  explore: Offer | null;
  /** Per riferimento del percorso (`pack:slug`). */
  routes: Map<string, Offer>;
  /** Singoli luoghi bloccati in vendita, per riferimento del luogo (`pack:slug`). */
  places: Map<string, Offer>;
  /** Contenuti singoli in vendita, per riferimento del luogo (`pack:slug`). */
  units: Map<string, Offer>;
  /** «Tutte le destinazioni». */
  all: Offer | null;
}

const slugOf = (ref: string) => ref.slice(ref.lastIndexOf(":") + 1);

const baseOffer = (item: CatalogItem, locale: string): Offer => ({
  productId: item.id,
  name: item.labels[locale]?.name ?? item.labels.it?.name ?? item.labels.en?.name ?? "",
  amount: item.price.amount,
  bundle: item.kind === "bundle",
});

/** Offerta con il preventivo dell'utente, se c'è; null se ce l'ha già (o ha già tutti i contenuti del livello). */
function priced(item: CatalogItem, locale: string, quotes: ReadonlyMap<string, Quote>): Offer | null {
  const o = baseOffer(item, locale);
  const q = quotes.get(item.id);
  if (!q) return o;
  if (q.status === "owned" || q.status === "complete" || q.status === "unpriced" || q.amount === null) return null;
  const list = q.list ?? o.amount;
  return {
    ...o,
    amount: q.amount,
    // Prezzo barrato e «Hai già scoperto…» solo se l'utente possiede già qualcosa del livello. Senza, un prezzo sotto
    // il listino viene dal tetto dei singoli (per esempio un luogo con un solo contenuto costa quanto il singolo): è
    // il prezzo per tutti, non uno sconto personale.
    ...(q.amount < list && q.owned > 0 ? { list, progress: { owned: q.owned, total: q.total } } : {}),
    ...(q.status === "below_minimum" ? { belowMinimum: true as const } : {}),
  };
}

/**
 * Per ogni contenuto bloccato, il prodotto acquistabile: il percorso singolo se c'è, altrimenti il pacchetto più
 * economico; per i luoghi bloccati (solo quelli della destinazione) il prodotto di quel luogo.
 */
export function offersFor(
  locked: BundleLocked | undefined,
  items: CatalogItem[],
  locale: string,
  places?: { destination: string; refs: Iterable<string>; unitRefs?: Iterable<string> },
  quotes: readonly Quote[] = [],
): Offers {
  const result: Offers = { explore: null, routes: new Map(), places: new Map(), units: new Map(), all: null };
  if (!locked) return result;
  const byProduct = new Map(quotes.map((q) => [q.product, q]));
  const offer = (item: CatalogItem) => priced(item, locale, byProduct);
  const buyable = items.filter((i) => i.available && i.price.currency === "EUR");
  const explore = buyable.find((i) => i.kind === "explore");
  if (locked.explore && explore) result.explore = offer(explore);
  const all = buyable.find((i) => i.kind === "all");
  // Chi ha già l'esplorazione di questa destinazione vede comunque «Tutte» (comprende le altre destinazioni).
  if (locked.explore && all) result.all = offer(all);
  for (const r of locked.routes) {
    const slug = slugOf(r.ref);
    const single = buyable.find((i) => i.kind === "route" && i.route === slug);
    const packs = buyable.filter((i) => i.kind === "bundle" && (i.routes ?? []).includes(slug)).sort((a, b) => a.price.amount - b.price.amount);
    const best = single ?? packs[0];
    const o = best ? offer(best) : null;
    if (o) result.routes.set(r.ref, o);
  }
  if (locked.explore && places) {
    for (const ref of places.refs) {
      if (!ref.startsWith(`${places.destination}:`)) continue;
      const single = buyable.find((i) => i.kind === "place" && i.place === slugOf(ref));
      const o = single ? offer(single) : null;
      if (o) result.places.set(ref, o);
    }
    for (const ref of places.unitRefs ?? []) {
      if (!ref.startsWith(`${places.destination}:`)) continue;
      const single = buyable.find((i) => i.kind === "unit" && i.place === slugOf(ref));
      const o = single ? offer(single) : null;
      if (o) result.units.set(ref, o);
    }
  }
  return result;
}

/** «4,99 €» / «€4.99». */
export const formatPrice = (cents: number, locale: string) =>
  new Intl.NumberFormat(locale === "it" ? "it-IT" : "en-GB", { style: "currency", currency: "EUR" }).format(cents / 100);

/**
 * Luoghi a pagamento: con l'esplorazione a pagamento, quelli senza racconti nel bundle pubblico (restano sulla
 * elenco, ma la guida non li racconta finché non si acquista il luogo o l'esplorazione completa). Quali siano lo
 * decide lo Studio (gratuiti esclusi; dei luoghi principali resta pubblica la panoramica); un luogo comprato non è più fra questi.
 */
export function lockedPlaceRefs(content: Pick<BundleContent, "locked" | "places" | "units">): Set<string> {
  if (!content.locked?.explore) return new Set();
  // Il bundle elenca i luoghi a pagamento secondo lo Studio, già senza quelli acquistati (mergePremium).
  if (content.locked.places) {
    const paid = new Set(content.locked.places);
    return new Set(content.places.filter((p) => paid.has(p.ref)).map((p) => p.ref));
  }
  // Bundle precedenti senza l'elenco: bloccato ogni luogo senza racconti pubblici.
  const told = new Set(content.units.map((u) => u.anchor));
  return new Set(content.places.filter((p) => !told.has(p.ref)).map((p) => p.ref));
}
