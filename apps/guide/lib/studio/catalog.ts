/**
 * Catalogo dello Studio: regole pure (testate in test/catalog.test.ts). Gli stessi limiti valgono nel database
 * (supabase/migrations/20261025000000_catalog.sql): qui servono a dare un messaggio subito, non a proteggere.
 */

/** Centesimi di euro: da 0,50 € a 999 € (vincolo di product_prices). */
export const PRICE_MIN_CENTS = 50;
export const PRICE_MAX_CENTS = 99_900;

/**
 * Importo scritto in euro («4,99», «4.99», «5», «€ 12,50») → centesimi interi, senza arrotondamenti nascosti:
 * al massimo due decimali, niente migliaia con separatore. null se non è un importo valido.
 */
export function parseEuro(raw: string): number | null {
  const s = raw.replace(/€/g, "").replace(/\s+/g, "").trim();
  const m = /^(\d{1,6})(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Messaggio per un importo fuori dai limiti o non valido; null se va bene. */
export function priceProblem(cents: number | null): string | null {
  if (cents === null) return "Prezzo non valido: scrivilo in euro, per esempio 4,99.";
  if (cents < PRICE_MIN_CENTS || cents > PRICE_MAX_CENTS) return "Prezzo fuori dai limiti: da 0,50 € a 999 €.";
  return null;
}

/** 499 → «4,99 €». */
export function formatEuro(cents: number): string {
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")} €`;
}

export const PRODUCT_KIND_LABELS: Record<string, string> = {
  explore: "Esplorazione", route: "Percorso", bundle: "Pacchetto di percorsi", place: "Luogo",
};
/** Prezzo predefinito di un singolo luogo: il minimo che Stripe accetta (decisione del 2026-10-18). */
export const PLACE_DEFAULT_CENTS = PRICE_MIN_CENTS;
export const PRODUCT_STATUS_LABELS: Record<string, string> = { draft: "Bozza", active: "In vendita", retired: "Ritirato" };
export const AVAILABILITY_LABELS: Record<string, string> = { available: "Disponibile", hidden: "Nascosto", sold_out: "Esaurito" };

export interface CatalogProduct {
  id: string;
  slug: string;
  kind: "explore" | "route" | "bundle" | "place";
  labels: { it?: { name?: string; description?: string }; en?: { name?: string; description?: string } };
  status: "draft" | "active" | "retired";
  availability: "available" | "hidden" | "sold_out";
  sortOrder: number;
  route: { id: string; slug: string } | null;
  /** Luogo, per i prodotti «place» (migrazione 20261028000000). */
  place?: { id: string; slug: string } | null;
  routes: string[];
  published: { amount: number; at: string } | null;
  draft: { amount: number } | null;
  paidOrders: number;
  problem: string | null;
}

export interface CatalogState {
  isDestination: boolean;
  explore: "free" | "premium";
  routes: { id: string; slug: string; name: string; premium: boolean }[];
  /** Luoghi della destinazione; «sellable» se si possono vendere da soli (esplorazione a pagamento, non introduttivi). */
  places?: { id: string; slug: string; name: string; sellable: boolean }[];
  products: CatalogProduct[];
  drafts: number;
}

/** Luoghi vendibili che non hanno ancora un prodotto (non ritirato): quelli che «Metti in vendita i luoghi» crea. */
export function placesWithoutProduct(c: Pick<CatalogState, "places" | "products">): NonNullable<CatalogState["places"]> {
  const withProduct = new Set(c.products.filter((p) => p.kind === "place" && p.status !== "retired").map((p) => p.place?.slug));
  return (c.places ?? []).filter((pl) => pl.sellable && !withProduct.has(pl.slug));
}

/** In vendita davvero: attivo, non nascosto, con un prezzo pubblicato e coerente con l'accesso (come public_catalog). */
export function onSale(p: CatalogProduct): boolean {
  return p.status === "active" && p.availability !== "hidden" && p.published !== null && p.problem === null;
}
