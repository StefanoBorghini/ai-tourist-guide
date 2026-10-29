"use server";
/**
 * Azioni della scheda «Attività» dello Studio. Come le altre: utente verificato di nuovo (requireStaff) e scrittura
 * con la sua identità attraverso le funzioni studio_*_local_business (migrazione 20261105000000), che applicano
 * permessi, verifica dei dati e regole di pubblicazione. Nessuna chiave di servizio.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff, rpc } from "../../lib/studio/server";
import { checkMediaRights, friendlyError, MEDIA_SOURCES } from "../../lib/studio/shared";
import {
  BUSINESS_PHOTO_LICENSES, BUSINESS_PHOTOS_BUCKET, businessPayloadFromForm, type FormValues, type StudioBusiness,
} from "../../lib/studio/local-businesses";

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
  // Le foto registrate se ne vanno con l'attività; i loro file si tolgono dal bucket subito dopo.
  const list = await rpc<StudioBusiness[]>(supabase, "studio_local_businesses", { p_pack: pack });
  const paths = (list.data ?? []).find((b) => b.id === id)?.photos?.map((f) => f.path) ?? [];
  const { error } = await rpc(supabase, "studio_delete_local_business", { p_id: id });
  if (error) back(itemPath(pack, id), { errore: friendlyError(error) });
  const removed = paths.length > 0 ? await supabase.storage.from(BUSINESS_PHOTOS_BUCKET).remove(paths) : { error: null };
  revalidatePath(listPath(pack));
  back(listPath(pack), {
    ok: removed.error ? `Attività eliminata; ${paths.length} file di foto non sono stati tolti dal bucket: ${removed.error.message}` : "Attività eliminata.",
  });
}

// ---------------------------------------------------------------- foto (migrazione 20261106000000)

export interface AddBusinessPhotoInput {
  pack: string;
  business: string;
  path: string;
  altIt: string;
  altEn: string;
  author: string;
  license: string;
  source: string;
  originalUrl: string;
  licenseNote: string;
}

/** Registra una foto già caricata dal browser nel bucket; in caso d'errore il browser toglie il file. */
export async function addBusinessPhoto(input: AddBusinessPhotoInput): Promise<{ error: string | null }> {
  const { supabase } = await requireStaff();
  if (!UUID_RE.test(input.business)) return { error: "Attività non riconosciuta." };
  if (!(BUSINESS_PHOTO_LICENSES as readonly string[]).includes(input.license)) return { error: "Licenza non ammessa per le foto delle attività." };
  if (!(MEDIA_SOURCES as readonly string[]).includes(input.source)) return { error: "Provenienza non valida." };
  const rights = checkMediaRights(input);
  if (rights) return { error: rights };
  const { error } = await rpc(supabase, "studio_add_business_photo", {
    p_business: input.business,
    p: {
      path: input.path,
      alt: { it: input.altIt, en: input.altEn },
      author: input.author,
      license: input.license,
      source: input.source,
      originalUrl: input.originalUrl || null,
      licenseNote: input.licenseNote,
    },
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath(itemPath(input.pack, input.business));
  return { error: null };
}

export async function deleteBusinessPhoto(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const id = text(form, "id");
  const { data: path, error } = await rpc<string>(supabase, "studio_delete_business_photo", { p_id: text(form, "photo") });
  if (error || !path) back(itemPath(pack, id), { errore: friendlyError(error) });
  const removed = await supabase.storage.from(BUSINESS_PHOTOS_BUCKET).remove([path!]);
  revalidatePath(itemPath(pack, id));
  back(itemPath(pack, id), { ok: removed.error ? `Foto tolta dalla guida; il file è rimasto nel bucket: ${removed.error.message}` : "Foto eliminata." });
}

export async function firstBusinessPhoto(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const id = text(form, "id");
  const { error } = await rpc(supabase, "studio_first_business_photo", { p_id: text(form, "photo") });
  if (error) back(itemPath(pack, id), { errore: friendlyError(error) });
  revalidatePath(itemPath(pack, id));
  back(itemPath(pack, id), { ok: "Foto messa per prima: è la copertina dell'attività nella guida." });
}
