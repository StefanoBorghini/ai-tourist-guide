"use server";
/**
 * Azioni della scheda «Attività» dello Studio. Come le altre: utente verificato di nuovo (requireStaff) e scrittura
 * con la sua identità attraverso le funzioni studio_*_local_business (migrazione 20261105000000), che applicano
 * permessi, verifica dei dati e regole di pubblicazione. Nessuna chiave di servizio.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff, rpc } from "../../lib/studio/server";
import { friendlyError } from "../../lib/studio/shared";
import { businessPayloadFromForm, type FormValues, type StudioBusiness } from "../../lib/studio/local-businesses";

const back = (path: string, result: Record<string, string | undefined>): never => {
  const q = new URLSearchParams(Object.entries(result).filter((e): e is [string, string] => e[1] !== undefined)).toString();
  redirect(`${path}?${q}`);
};
const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const listPath = (pack: string) => `/studio/${encodeURIComponent(pack)}/attivita`;
const itemPath = (pack: string, id: string) => `${listPath(pack)}/${encodeURIComponent(id)}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formValues(form: FormData): FormValues {
  const v: FormValues = {};
  for (const [key, value] of form.entries()) if (typeof value === "string") v[key] = value;
  return v;
}

/** Crea (senza id) o modifica un'attività; con «Ho verificato i dati ora» la verifica è registrata nello stesso salvataggio. */
export async function saveLocalBusiness(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const id = text(form, "id") || null;
  if (id !== null && !UUID_RE.test(id)) back(listPath(pack), { errore: "Attività non riconosciuta." });
  const path = id ? itemPath(pack, id) : `${listPath(pack)}/nuova`;
  const k = await rpc<{ locales: string[] }>(supabase, "studio_pack", { p_pack: pack });
  if (!k.data) back(path, { errore: k.error ? friendlyError(k.error) : "Territorio non trovato." });
  const parsed = businessPayloadFromForm(formValues(form), k.data!.locales);
  if (!parsed.ok) back(path, { errore: parsed.error });
  const payload = (parsed as { ok: true; payload: Record<string, unknown> }).payload;
  const { data, error } = await rpc<StudioBusiness>(supabase, "studio_save_local_business", {
    p_pack: pack,
    p_id: id,
    p: payload,
    p_verify: form.get("verify") === "on",
  });
  if (error || !data) back(path, { errore: friendlyError(error) });
  revalidatePath(listPath(pack));
  back(itemPath(pack, data!.id), { ok: id ? "Attività salvata." : "Attività creata in bozza." });
}

export async function verifyLocalBusiness(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const id = text(form, "id");
  const { error } = await rpc(supabase, "studio_verify_local_business", { p_id: id, p_note: text(form, "note") || null });
  if (error) back(itemPath(pack, id), { errore: friendlyError(error) });
  revalidatePath(listPath(pack));
  back(itemPath(pack, id), { ok: "Dati segnati come verificati oggi." });
}

const PUBLICATION_OK: Record<string, string> = {
  published: "Attività pubblicata: compare nella guida entro qualche minuto.",
  withdrawn: "Attività ritirata: sparisce dalla guida entro qualche minuto.",
  draft: "Attività tornata in bozza.",
};

export async function setLocalBusinessPublication(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const id = text(form, "id");
  const to = text(form, "to");
  if (!Object.hasOwn(PUBLICATION_OK, to)) back(itemPath(pack, id), { errore: "Operazione non riconosciuta." });
  const { error } = await rpc(supabase, "studio_set_local_business_publication", { p_id: id, p_to: to });
  if (error) back(itemPath(pack, id), { errore: friendlyError(error) });
  revalidatePath(listPath(pack));
  back(itemPath(pack, id), { ok: PUBLICATION_OK[to] });
}

/** Solo bozze (un'attività pubblicata o ritirata la elimina l'amministratore); serve la conferma esplicita. */
export async function deleteLocalBusiness(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const id = text(form, "id");
  if (form.get("confirm") !== "on") back(itemPath(pack, id), { errore: "Per eliminare spunta la conferma." });
  const { error } = await rpc(supabase, "studio_delete_local_business", { p_id: id });
  if (error) back(itemPath(pack, id), { errore: friendlyError(error) });
  revalidatePath(listPath(pack));
  back(listPath(pack), { ok: "Attività eliminata." });
}
