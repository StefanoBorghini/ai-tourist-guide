/**
 * Vendita nell'app: abbina i contenuti a pagamento di un bundle (content.locked) ai prodotti del listino pubblico
 * (public_catalog, letto da /api/catalog). Puro (test in test/shop.test.ts). Il prezzo mostrato è solo informativo:
 * l'importo addebitato lo decide il server al checkout.
 */
import type { BundleContent } from "@guide/bundle/client";

type BundleLocked = NonNullable<BundleContent["locked"]>;

export interface CatalogItem {
  id: string;
  kind: "explore" | "route" | "bundle" | "place";
  labels: Record<string, { name?: string; description?: string } | undefined>;
  route?: string | null;
  /** Luogo (slug), per i prodotti «place» (migrazione 20261028000000). */
  place?: string | null;
  routes?: string[];
  price: { amount: number; currency: string };
  available: boolean;
}

export interface Offer {
  productId: string;
  name: string;
  amount: number;
  /** Pacchetto di più percorsi (lo si dice, perché il prezzo vale per tutti). */
  bundle: boolean;
}

export interface Offers {
  explore: Offer | null;
  /** Per riferimento del percorso (`pack:slug`). */
  routes: Map<string, Offer>;
  /** Singoli luoghi bloccati in vendita, per riferimento del luogo (`pack:slug`). */
  places: Map<string, Offer>;
}

const slugOf = (ref: string) => ref.slice(ref.lastIndexOf(":") + 1);

const offer = (item: CatalogItem, locale: string): Offer => ({
  productId: item.id,
  name: item.labels[locale]?.name ?? item.labels.it?.name ?? item.labels.en?.name ?? "",
  amount: item.price.amount,
  bundle: item.kind === "bundle",
});

/**
 * Per ogni contenuto bloccato, il prodotto acquistabile: il percorso singolo se c'è, altrimenti il pacchetto più
 * economico; per i luoghi bloccati (solo quelli della destinazione) il prodotto di quel luogo.
 */
export function offersFor(
  locked: BundleLocked | undefined,
  items: CatalogItem[],
  locale: string,
  places?: { destination: string; refs: Iterable<string> },
): Offers {
  const result: Offers = { explore: null, routes: new Map(), places: new Map() };
  if (!locked) return result;
  const buyable = items.filter((i) => i.available && i.price.currency === "EUR");
  const explore = buyable.find((i) => i.kind === "explore");
  if (locked.explore && explore) result.explore = offer(explore, locale);
  for (const r of locked.routes) {
    const slug = slugOf(r.ref);
    const single = buyable.find((i) => i.kind === "route" && i.route === slug);
    const packs = buyable.filter((i) => i.kind === "bundle" && (i.routes ?? []).includes(slug)).sort((a, b) => a.price.amount - b.price.amount);
    const best = single ?? packs[0];
    if (best) result.routes.set(r.ref, offer(best, locale));
  }
  if (locked.explore && places) {
    for (const ref of places.refs) {
      if (!ref.startsWith(`${places.destination}:`)) continue;
      const single = buyable.find((i) => i.kind === "place" && i.place === slugOf(ref));
      if (single) result.places.set(ref, offer(single, locale));
    }
  }
  return result;
}

/** «4,99 €» / «€4.99». */
export const formatPrice = (cents: number, locale: string) =>
  new Intl.NumberFormat(locale === "it" ? "it-IT" : "en-GB", { style: "currency", currency: "EUR" }).format(cents / 100);

/**
 * Luoghi a pagamento: con l'esplorazione a pagamento, quelli senza racconti nel bundle pubblico (restano sulla
 * elenco, ma la guida non li racconta finché non si acquista il luogo o l'esplorazione completa). Un luogo comprato da
 * solo ha i suoi racconti nel contenuto unito (mergePremium) e quindi non è più fra questi.
 */
export function lockedPlaceRefs(content: Pick<BundleContent, "locked" | "places" | "units">): Set<string> {
  if (!content.locked?.explore) return new Set();
  const told = new Set(content.units.map((u) => u.anchor));
  // Solo i luoghi con racconti a pagamento (il bundle li elenca): un luogo introduttivo, o senza racconti, è gratuito.
  // I bundle precedenti non hanno l'elenco: allora bloccato è ogni luogo senza racconti pubblici.
  const paid = content.locked.places ? new Set(content.locked.places) : null;
  return new Set(content.places.filter((p) => !told.has(p.ref) && (paid ? paid.has(p.ref) : true)).map((p) => p.ref));
}
