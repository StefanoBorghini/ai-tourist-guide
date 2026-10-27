"use server";
/**
 * Azioni della scheda «Avvisi» dello Studio. Come quelle degli eventi: utente verificato di nuovo (requireStaff) e
 * scrittura con la sua identità attraverso le funzioni studio_*_operational_notice (migrazione 20261105000000), che
 * applicano permessi, verifica della fonte e regole di pubblicazione. Nessuna chiave di servizio.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff, rpc } from "../../lib/studio/server";
import { friendlyError } from "../../lib/studio/shared";
import { noticePayloadFromForm, type StudioNotice } from "../../lib/studio/operational-notices";

const back = (path: string, result: Record<string, string | undefined>): never => {
  const q = new URLSearchParams(Object.entries(result).filter((e): e is [string, string] => e[1] !== undefined)).toString();
  redirect(`${path}?${q}`);
};
const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const noticesPath = (pack: string) => `/studio/${encodeURIComponent(pack)}/avvisi`;
const noticePath = (pack: string, id: string) => `${noticesPath(pack)}/${encodeURIComponent(id)}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Crea (senza id) o modifica un avviso; con «Ho verificato la fonte ora» la verifica è registrata nello stesso salvataggio. */
export async function saveOperationalNotice(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const id = text(form, "id") || null;
  if (id !== null && !UUID_RE.test(id)) back(noticesPath(pack), { errore: "Avviso non riconosciuto." });
  const path = id ? noticePath(pack, id) : `${noticesPath(pack)}/nuovo`;
  const k = await rpc<{ locales: string[]; defaultLocale: string }>(supabase, "studio_pack", { p_pack: pack });
  if (!k.data) back(path, { errore: k.error ? friendlyError(k.error) : "Territorio non trovato." });
  const parsed = noticePayloadFromForm((name) => String(form.get(name) ?? ""), k.data!.locales, k.data!.defaultLocale);
  if (!parsed.ok) back(path, { errore: parsed.error });
  const { data, error } = await rpc<StudioNotice>(supabase, "studio_save_operational_notice", {
    p_pack: pack,
    p_id: id,
    p: (parsed as { ok: true; payload: Record<string, unknown> }).payload,
    p_verify: form.get("verify") === "on",
  });
  if (error || !data) back(path, { errore: friendlyError(error) });
  revalidatePath(noticesPath(pack));
  back(noticePath(pack, data!.id), { ok: id ? "Avviso salvato." : "Avviso creato in bozza." });
}

export async function verifyOperationalNotice(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const id = text(form, "id");
  const { error } = await rpc(supabase, "studio_verify_operational_notice", { p_id: id, p_note: text(form, "note") || null });
  if (error) back(noticePath(pack, id), { errore: friendlyError(error) });
  revalidatePath(noticesPath(pack));
  back(noticePath(pack, id), { ok: "Fonte segnata come verificata ora." });
}

const PUBLICATION_OK: Record<string, string> = {
  published: "Avviso pubblicato: Gaia lo usa entro un minuto.",
  withdrawn: "Avviso ritirato: Gaia smette di usarlo entro un minuto.",
  draft: "Avviso tornato in bozza.",
};

export async function setOperationalNoticePublication(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const id = text(form, "id");
  const to = text(form, "to");
  if (!Object.hasOwn(PUBLICATION_OK, to)) back(noticePath(pack, id), { errore: "Operazione non riconosciuta." });
  const { error } = await rpc(supabase, "studio_set_operational_notice_publication", { p_id: id, p_to: to });
  if (error) back(noticePath(pack, id), { errore: friendlyError(error) });
  revalidatePath(noticesPath(pack));
  back(noticePath(pack, id), { ok: PUBLICATION_OK[to] });
}

/** Le bozze le elimina chi modifica il territorio, gli altri avvisi l'amministratore; serve la conferma esplicita. */
export async function deleteOperationalNotice(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const id = text(form, "id");
  if (form.get("confirm") !== "on") back(noticePath(pack, id), { errore: "Per eliminare spunta la conferma." });
  const { error } = await rpc(supabase, "studio_delete_operational_notice", { p_id: id });
  if (error) back(noticePath(pack, id), { errore: friendlyError(error) });
  revalidatePath(noticesPath(pack));
  back(noticesPath(pack), { ok: "Avviso eliminato." });
}
