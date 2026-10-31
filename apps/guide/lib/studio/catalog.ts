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
  explore: "Esplorazione", route: "Percorso", bundle: "Pacchetto di percorsi", place: "Luogo principale",
  unit: "Contenuto singolo", all: "Tutte le destinazioni",
};
/** Livelli del listino centrale (migrazione 20261107000000_progressive_purchase.sql), dal più piccolo. */
export const TIER_KINDS = ["unit", "place", "explore", "all"] as const;
export type TierKind = (typeof TIER_KINDS)[number];
export const TIER_LABELS: Record<TierKind, string> = {
  unit: "Contenuto singolo (un sottoluogo)",
  place: "Luogo principale con i suoi sottoluoghi",
  explore: "Destinazione completa",
  all: "Tutte le destinazioni",
};
/** Prezzo proposto per un luogo principale, con i suoi sottoluoghi (decisione del 2026-10-22). */
export const PLACE_DEFAULT_CENTS = 199;
export const PRODUCT_STATUS_LABELS: Record<string, string> = { draft: "Bozza", active: "In vendita", retired: "Ritirato" };
export const AVAILABILITY_LABELS: Record<string, string> = { available: "Disponibile", hidden: "Nascosto", sold_out: "Esaurito" };

export interface CatalogProduct {
  id: string;
  slug: string;
  kind: "explore" | "route" | "bundle" | "place" | "unit" | "all";
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
  /** Tariffa pubblicata del suo livello: vale se il prodotto non ha un prezzo proprio pubblicato. */
  tier?: { amount: number } | null;
  paidOrders: number;
  problem: string | null;
}

export interface CatalogState {
  isDestination: boolean;
  explore: "free" | "premium";
  routes: { id: string; slug: string; name: string; premium: boolean }[];
  /**
   * Luoghi della destinazione; «sellable» se si possono vendere (esplorazione a pagamento, luogo principale non
   * gratuito); «parent» il luogo principale di un sottoluogo, «subPlaces» quanti sottoluoghi ha un principale
   * (migrazione 20261101000000).
   */
  places?: {
    id: string; slug: string; name: string; sellable: boolean; parent?: string | null; subPlaces?: number;
    /** Acquisto progressivo: è un contenuto vendibile da solo; quanti contenuti ha il luogo principale. */
    isUnit?: boolean; units?: number;
  }[];
  /** Contenuti a pagamento della destinazione (unità dell'acquisto progressivo). */
  units?: number;
  products: CatalogProduct[];
  drafts: number;
}

/** Listino centrale, «Tutte le destinazioni» e ordini da rivedere (studio_commerce). */
export interface CommerceState {
  tiers: { kind: TierKind; published: { amount: number; at: string } | null; draft: { amount: number } | null }[];
  all: {
    product: { id: string; slug: string; status: "draft" | "active" | "retired"; paidOrders: number } | null;
    problem: string | null;
    destinations: string[];
    units: number;
  };
  reviews: {
    id: string; product: string; kind: string; status: string; amount: number; list: number | null;
    paidAt: string | null; reason: string; at: string;
  }[];
}

/** Prezzo di listino effettivo: il prezzo proprio pubblicato, altrimenti la tariffa del livello. */
export function listPrice(p: Pick<CatalogProduct, "published" | "tier">): { amount: number; source: "own" | "tier" } | null {
  if (p.published) return { amount: p.published.amount, source: "own" };
  if (p.tier) return { amount: p.tier.amount, source: "tier" };
  return null;
}

/** Luoghi vendibili che non hanno ancora un prodotto (non ritirato): quelli che «Metti in vendita i luoghi» crea. */
export function placesWithoutProduct(c: Pick<CatalogState, "places" | "products">): NonNullable<CatalogState["places"]> {
  const withProduct = new Set(c.products.filter((p) => p.kind === "place" && p.status !== "retired").map((p) => p.place?.slug));
  return (c.places ?? []).filter((pl) => pl.sellable && !withProduct.has(pl.slug));
}

/** Prodotti ancora attivi di luoghi diventati sottoluoghi: «Metti in vendita i luoghi principali» li ritira. */
export function subPlaceProducts(c: Pick<CatalogState, "places" | "products">): CatalogProduct[] {
  const subs = new Set((c.places ?? []).filter((pl) => pl.parent).map((pl) => pl.slug));
  return c.products.filter((p) => p.kind === "place" && p.status !== "retired" && p.place && subs.has(p.place.slug));
}

/**
 * In vendita davvero: attivo, non nascosto, con un prezzo (proprio o di listino) pubblicato e coerente con l'accesso
 * (come public_catalog).
 */
export function onSale(p: CatalogProduct): boolean {
  return p.status === "active" && p.availability !== "hidden" && listPrice(p) !== null && p.problem === null;
}

/**
 * Contenuti vendibili da soli che non hanno ancora il loro prodotto: solo sottoluoghi (un luogo principale si vende
 * intero, migrazione 20261108000000), di luoghi con almeno due contenuti.
 */
export function unitsWithoutProduct(c: Pick<CatalogState, "places" | "products">): NonNullable<CatalogState["places"]> {
  const withProduct = new Set(c.products.filter((p) => p.kind === "unit" && p.status !== "retired").map((p) => p.place?.slug));
  const units = new Map((c.places ?? []).map((pl) => [pl.slug, pl.units ?? 0]));
  return (c.places ?? []).filter((pl) => pl.isUnit && pl.parent && !withProduct.has(pl.slug) && (units.get(pl.parent) ?? 0) >= 2);
}

/** File «unit» dell'ultima pubblicazione (manifest pubblico): solo riferimento e conteggi. */
export interface PublishedUnitFile {
  ref?: string;
  stories?: number;
  verifiedStories?: number;
}

export type SubPlaceSaleState =
  | "on_sale" // in vendita da solo
  | "ready" // vendibile: manca il prodotto («Metti in vendita i contenuti singoli»)
  | "only_content" // unico contenuto del suo luogo: si vende con il luogo, allo stesso prezzo
  | "no_stories" // nessun racconto pubblicato
  | "in_review" // racconti pubblicati ma con affermazioni in revisione
  | "not_published" // non c'è nell'ultima pubblicazione
  | "free"; // gratuito o comunque non a pagamento

export interface SubPlaceSaleRow {
  slug: string;
  name: string;
  parent: string;
  parentName: string;
  stories: number | null;
  verified: number | null;
  state: SubPlaceSaleState;
}

export const SUB_PLACE_SALE_LABELS: Record<SubPlaceSaleState, string> = {
  on_sale: "In vendita da solo",
  ready: "Pronto: premi «Metti in vendita i contenuti singoli»",
  only_content: "Unico contenuto del suo luogo: si vende con il luogo, allo stesso prezzo del singolo",
  no_stories: "Nessun racconto pubblicato: aggiungi un racconto (le affermazioni in bozza non entrano mai), poi ripubblica",
  in_review: "Racconti in revisione: verifica i fatti, poi ripubblica",
  not_published: "Non è nell'ultima pubblicazione: ripubblica",
  free: "Gratuito o non a pagamento",
};

/**
 * Stato di vendita di ogni sottoluogo (acquisto progressivo, criterio rigoroso): perché si vende o non si vende da solo.
 * Usa i luoghi del catalogo dello Studio (studio_catalog), i suoi prodotti e i conteggi dei file «unit» dell'ultima
 * pubblicazione. Le regole sono quelle del database (commerce_units, catalog_problem_unit): qui servono solo a spiegare.
 */
export function subPlaceSaleRows(
  c: Pick<CatalogState, "places" | "products">,
  files: readonly PublishedUnitFile[],
  destination: string,
): SubPlaceSaleRow[] {
  const places = c.places ?? [];
  const nameOf = new Map(places.map((pl) => [pl.slug, pl.name]));
  const unitsOf = new Map(places.map((pl) => [pl.slug, pl.units ?? 0]));
  const fileOf = new Map(files.flatMap((f) => (f.ref ? [[f.ref, f] as const] : [])));
  const onSale = new Set(c.products.filter((p) => p.kind === "unit" && p.status === "active" && p.place).map((p) => p.place!.slug));
  return places
    .filter((pl) => pl.parent)
    .map((pl): SubPlaceSaleRow => {
      const f = fileOf.get(`${destination}:${pl.slug}`);
      const stories = f?.stories ?? null;
      const verified = f?.verifiedStories ?? null;
      const state: SubPlaceSaleState = pl.isUnit
        ? onSale.has(pl.slug)
          ? "on_sale"
          : (unitsOf.get(pl.parent!) ?? 0) < 2
            ? "only_content"
            : "ready"
        : !f
          ? files.length > 0 ? "free" : "not_published"
          : (stories ?? 0) === 0
            ? "no_stories"
            : (verified ?? 0) === 0
              ? "in_review"
              : "free";
      return { slug: pl.slug, name: pl.name, parent: pl.parent!, parentName: nameOf.get(pl.parent!) ?? pl.parent!, stories, verified, state };
    })
    .sort((a, b) => a.parentName.localeCompare(b.parentName, "it") || a.name.localeCompare(b.name, "it"));
}
