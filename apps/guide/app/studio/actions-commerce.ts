"use server";
/**
 * Azioni dell'acquisto progressivo nella scheda «Vendita» (migrazione 20261107000000_progressive_purchase.sql): listino
 * centrale, «Segui il listino», contenuti singoli in vendita, «Tutte le destinazioni», ordini da rivedere. Solo
 * l'amministratore della piattaforma: lo verificano le funzioni studio_* del database, con la sua identità.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formatEuro, parseEuro, priceProblem, TIER_KINDS, type TierKind } from "../../lib/studio/catalog";
import { requireStaff, rpc } from "../../lib/studio/server";
import { friendlyError } from "../../lib/studio/shared";

const back = (path: string, result: Record<string, string | undefined>): never => {
  const q = new URLSearchParams(Object.entries(result).filter((e): e is [string, string] => e[1] !== undefined)).toString();
  redirect(`${path}?${q}`);
};
const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const salePath = (pack: string) => `/studio/${encodeURIComponent(pack)}/vendita`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tariffa in bozza di un livello; vuota toglie la bozza. */
export async function setTierDraft(form: FormData) {
  const { supabase } = await requireStaff();
  const path = salePath(text(form, "pack"));
  const kind = text(form, "kind") as TierKind;
  if (!TIER_KINDS.includes(kind)) back(path, { errore: "Livello non valido." });
  const clear = form.get("clear") === "1";
  const cents = clear ? null : parseEuro(text(form, "price"));
  if (!clear) {
    const problem = priceProblem(cents);
    if (problem) back(path, { errore: problem });
  }
  const { error } = await rpc(supabase, "studio_price_tier_draft", { p_kind: kind, p_amount: cents });
  if (error) back(path, { errore: friendlyError(error) });
  revalidatePath(path);
  back(path, { ok: clear ? "Bozza della tariffa tolta." : `Tariffa in bozza: ${formatEuro(cents!)}. Vale solo dopo «Pubblica il listino».` });
}

export async function publishTiers(form: FormData) {
  const { supabase } = await requireStaff();
  const path = salePath(text(form, "pack"));
  const { data, error } = await rpc<number>(supabase, "studio_price_tiers_publish", {});
  if (error) back(path, { errore: friendlyError(error) });
  revalidatePath(path);
  back(path, { ok: `Listino pubblicato (${data} tariffe): vale subito per tutti i prodotti senza un prezzo proprio.` });
}

/** Il prodotto lascia il suo prezzo e segue la tariffa del suo livello. */
export async function followTier(form: FormData) {
  const { supabase } = await requireStaff();
  const path = salePath(text(form, "pack"));
  const product = text(form, "product");
  if (!UUID_RE.test(product)) back(path, { errore: "Prodotto non valido." });
  const { error } = await rpc(supabase, "studio_product_follow_tier", { p_product: product });
  if (error) back(path, { errore: friendlyError(error) });
  revalidatePath(path);
  back(path, { ok: "Il prodotto ora segue il listino: il prezzo precedente resta nello storico." });
}

/** Crea i prodotti «Contenuto singolo» che mancano e ritira quelli non più vendibili. */
export async function unitsOnSale(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const path = salePath(pack);
  const { data, error } = await rpc<{ created: number; retired: number }>(supabase, "studio_units_on_sale", { p_pack: pack });
  if (error) back(path, { errore: friendlyError(error) });
  revalidatePath(path);
  const parts = [
    data?.created ? `Creati ${data.created} contenuti singoli, al prezzo di listino.` : "",
    data?.retired ? `Ritirati ${data.retired} contenuti singoli non più vendibili da soli.` : "",
  ].filter(Boolean);
  back(path, { ok: parts.join(" ") || "Tutti i contenuti singoli hanno già il loro prodotto." });
}

/** «Tutte le destinazioni»: in vendita o sospeso. */
export async function setAllProduct(form: FormData) {
  const { supabase } = await requireStaff();
  const path = salePath(text(form, "pack"));
  const active = form.get("active") === "1";
  const { error } = await rpc(supabase, "studio_all_product_set", { p_active: active });
  if (error) back(path, { errore: friendlyError(error) });
  revalidatePath(path);
  back(path, { ok: active ? "«Tutte le destinazioni» è in vendita." : "«Tutte le destinazioni» non è più in vendita (resta in bozza)." });
}

/** Ordine segnalato controllato. */
export async function reviewDone(form: FormData) {
  const { supabase } = await requireStaff();
  const path = salePath(text(form, "pack"));
  const order = text(form, "order");
  if (!UUID_RE.test(order)) back(path, { errore: "Ordine non valido." });
  const { error } = await rpc(supabase, "studio_order_review_done", { p_order: order });
  if (error) back(path, { errore: friendlyError(error) });
  revalidatePath(path);
  back(path, { ok: "Ordine segnato come rivisto." });
}
