"use server";
/**
 * Azioni della scheda «Domande» dello Studio: stato della revisione ed eliminazione. Come le altre azioni: utente
 * verificato di nuovo (requireStaff) e scrittura con la sua identità attraverso le funzioni studio_*_question_gap
 * (migrazione 20261104000000), che controllano i permessi sul territorio. Nessuna chiave di servizio.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff, rpc } from "../../lib/studio/server";
import { friendlyError } from "../../lib/studio/shared";
import { GAP_REVIEW_LABELS, isGapReview } from "../../lib/studio/question-gaps";

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const questionsPath = (pack: string, view: string) => `/studio/${encodeURIComponent(pack)}/domande${isGapReview(view) ? `?vista=${view}` : ""}`;
const back = (pack: string, view: string, result: Record<string, string>): never => {
  const q = new URLSearchParams(result).toString();
  const path = questionsPath(pack, view);
  redirect(`${path}${path.includes("?") ? "&" : "?"}${q}`);
};

export async function setQuestionGapStatus(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const view = text(form, "vista");
  const id = text(form, "id");
  const status = text(form, "status");
  if (!UUID_RE.test(id) || !isGapReview(status)) back(pack, view, { errore: "Operazione non riconosciuta." });
  const { error } = await rpc(supabase, "studio_set_question_gap_status", { p_id: id, p_status: status });
  if (error) back(pack, view, { errore: friendlyError(error) });
  revalidatePath(questionsPath(pack, ""));
  back(pack, view, { ok: `Domanda segnata come «${GAP_REVIEW_LABELS[status as keyof typeof GAP_REVIEW_LABELS]}».` });
}

/** Elimina definitivamente una domanda (per esempio se contiene dati personali); serve la conferma esplicita. */
export async function deleteQuestionGap(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const view = text(form, "vista");
  const id = text(form, "id");
  if (!UUID_RE.test(id)) back(pack, view, { errore: "Domanda non riconosciuta." });
  if (form.get("confirm") !== "on") back(pack, view, { errore: "Per eliminare spunta la conferma." });
  const { error } = await rpc(supabase, "studio_delete_question_gap", { p_id: id });
  if (error) back(pack, view, { errore: friendlyError(error) });
  revalidatePath(questionsPath(pack, ""));
  back(pack, view, { ok: "Domanda eliminata." });
}
