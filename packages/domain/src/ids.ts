/**
 * Identificativi globali.
 *
 * - Pack id: gerarchico, separato da punti, dal generale al particolare
 *   (es. "it.liguria.sp.portovenere"). Coincide con il nome della cartella del pack.
 * - Slug: identificativo locale di un nodo dentro un pack (es. "chiesa-di-san-pietro").
 * - Node ref: riferimento globale "<packId>:<slug>". Dentro un pack si può usare
 *   lo slug da solo per riferirsi a un nodo dello stesso pack.
 *
 * Gli slug non sono unici a livello globale (in Italia ci sono centinaia di
 * "chiese di San Pietro"): l'unicità è data dalla coppia pack + slug.
 */

const SLUG_SOURCE = "[a-z0-9]+(?:-[a-z0-9]+)*";
const PACK_ID_SOURCE = `${SLUG_SOURCE}(?:\\.${SLUG_SOURCE})*`;

export const SLUG_PATTERN = new RegExp(`^${SLUG_SOURCE}$`);
export const PACK_ID_PATTERN = new RegExp(`^${PACK_ID_SOURCE}$`);
export const NODE_REF_PATTERN = new RegExp(`^(${PACK_ID_SOURCE}):(${SLUG_SOURCE})$`);
/** Riferimento così come si scrive in un pack: slug locale oppure ref completo. */
export const REF_PATTERN = new RegExp(`^(?:(${PACK_ID_SOURCE}):)?(${SLUG_SOURCE})$`);

export interface NodeRef {
  packId: string;
  slug: string;
}

export function formatNodeRef(ref: NodeRef): string {
  return `${ref.packId}:${ref.slug}`;
}

/** Risolve un riferimento scritto in un pack ("slug" o "pack:slug") in un ref completo. */
export function resolveRef(raw: string, currentPackId: string): NodeRef | null {
  const match = REF_PATTERN.exec(raw);
  if (!match) return null;
  const [, packId, slug] = match;
  return { packId: packId ?? currentPackId, slug: slug! };
}

/** Il pack è uguale o discendente di `ancestor` nella gerarchia degli id. */
export function isPackWithin(packId: string, ancestor: string): boolean {
  return packId === ancestor || packId.startsWith(`${ancestor}.`);
}
