"use server";
/**
 * Azioni della scheda «Eventi» dello Studio. Come le altre azioni: utente verificato di nuovo (requireStaff) e
 * scrittura con la sua identità attraverso le funzioni studio_*_local_event (migrazione 20261031000000), che
 * applicano permessi, verifica della fonte e regole di pubblicazione. Nessuna chiave di servizio.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff, rpc } from "../../lib/studio/server";
import { friendlyError } from "../../lib/studio/shared";
import { eventPayloadFromForm, type FormValues, type StudioEvent } from "../../lib/studio/local-events";

const back = (path: string, result: Record<string, string | undefined>): never => {
  const q = new URLSearchParams(Object.entries(result).filter((e): e is [string, string] => e[1] !== undefined)).toString();
  redirect(`${path}?${q}`);
};
const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const eventsPath = (pack: string) => `/studio/${encodeURIComponent(pack)}/eventi`;
const eventPath = (pack: string, id: string) => `${eventsPath(pack)}/${encodeURIComponent(id)}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formValues(form: FormData): FormValues {
  const v: FormValues = {};
  for (const [key, value] of form.entries()) if (typeof value === "string") v[key] = value;
  return v;
}

/** Crea (senza id) o modifica un evento; con «Ho verificato la fonte ora» la verifica è registrata nello stesso salvataggio. */
export async function saveLocalEvent(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const id = text(form, "id") || null;
  if (id !== null && !UUID_RE.test(id)) back(eventsPath(pack), { errore: "Evento non riconosciuto." });
  const path = id ? eventPath(pack, id) : `${eventsPath(pack)}/nuovo`;
  const k = await rpc<{ locales: string[]; defaultLocale: string }>(supabase, "studio_pack", { p_pack: pack });
  if (!k.data) back(path, { errore: k.error ? friendlyError(k.error) : "Territorio non trovato." });
  const parsed = eventPayloadFromForm(formValues(form), k.data!.locales, k.data!.defaultLocale);
  if (!parsed.ok) back(path, { errore: parsed.error });
  const payload = (parsed as { ok: true; payload: Record<string, unknown> }).payload;
  const { data, error } = await rpc<StudioEvent>(supabase, "studio_save_local_event", {
    p_pack: pack,
    p_id: id,
    p: payload,
    p_verify: form.get("verify") === "on",
  });
  if (error || !data) back(path, { errore: friendlyError(error) });
  revalidatePath(eventsPath(pack));
  back(eventPath(pack, data!.id), { ok: id ? "Evento salvato." : "Evento creato in bozza." });
}

export async function verifyLocalEvent(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const id = text(form, "id");
  const { error } = await rpc(supabase, "studio_verify_local_event", { p_id: id, p_note: text(form, "note") || null });
  if (error) back(eventPath(pack, id), { errore: friendlyError(error) });
  revalidatePath(eventsPath(pack));
  back(eventPath(pack, id), { ok: "Fonte segnata come verificata ora." });
}

const PUBLICATION_OK: Record<string, string> = {
  published: "Evento pubblicato: compare nella guida entro qualche minuto.",
  withdrawn: "Evento ritirato: sparisce dalla guida entro qualche minuto.",
  draft: "Evento tornato in bozza.",
};

export async function setLocalEventPublication(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const id = text(form, "id");
  const to = text(form, "to");
  if (!Object.hasOwn(PUBLICATION_OK, to)) back(eventPath(pack, id), { errore: "Operazione non riconosciuta." });
  const { error } = await rpc(supabase, "studio_set_local_event_publication", { p_id: id, p_to: to });
  if (error) back(eventPath(pack, id), { errore: friendlyError(error) });
  revalidatePath(eventsPath(pack));
  back(eventPath(pack, id), { ok: PUBLICATION_OK[to] });
}

/** Annullato, rinviato, da confermare o di nuovo previsto: vale subito anche per un evento pubblicato. */
export async function setLocalEventStatus(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const id = text(form, "id");
  const { error } = await rpc(supabase, "studio_set_local_event_status", {
    p_id: id,
    p_status: text(form, "status"),
    p_note: text(form, "note") || null,
  });
  if (error) back(eventPath(pack, id), { errore: friendlyError(error) });
  revalidatePath(eventsPath(pack));
  back(eventPath(pack, id), { ok: "Stato dell'evento aggiornato." });
}

/** Solo bozze (un evento pubblicato o ritirato lo elimina l'amministratore); serve la conferma esplicita. */
export async function deleteLocalEvent(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const id = text(form, "id");
  if (form.get("confirm") !== "on") back(eventPath(pack, id), { errore: "Per eliminare spunta la conferma." });
  const { error } = await rpc(supabase, "studio_delete_local_event", { p_id: id });
  if (error) back(eventPath(pack, id), { errore: friendlyError(error) });
  revalidatePath(eventsPath(pack));
  back(eventsPath(pack), { ok: "Evento eliminato." });
}
