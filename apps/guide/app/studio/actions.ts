"use server";
/**
 * Azioni dello Studio. Ognuna verifica di nuovo l'utente (requireStaff) e passa dal database con la
 * sua identità: permessi, quattro occhi e storico li applicano le funzioni studio_* e le policy RLS.
 * L'esito torna nella pagina come messaggio (?ok= / ?errore=).
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff, rpc, studioClient, studioConfig } from "../../lib/studio/server";
import { checkStops, friendlyError, MEDIA_LICENSES, MEDIA_SOURCES } from "../../lib/studio/shared";

const back = (path: string, result: { ok?: string; errore?: string }): never => {
  const q = new URLSearchParams(result as Record<string, string>).toString();
  redirect(`${path}?${q}`);
};
const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const packPath = (pack: string) => `/studio/${encodeURIComponent(pack)}`;

// ---------------------------------------------------------------- accesso

export async function signIn(form: FormData) {
  const config = studioConfig();
  if (!config) back("/studio/login", { errore: "Studio non configurato." });
  const supabase = await studioClient(config!);
  const { error } = await supabase.auth.signInWithPassword({ email: text(form, "email"), password: String(form.get("password") ?? "") });
  // Stesso messaggio per email sconosciuta e password errata; per gli altri casi il codice di Supabase
  // (non contiene dati personali) aiuta a capire se il problema è di configurazione.
  if (error) back("/studio/login", { errore: loginError(error) });
  redirect("/studio");
}

function loginError(error: { code?: string; status?: number; message?: string }): string {
  const code = error.code ?? "";
  if (code === "invalid_credentials") return "Email o password non corrette.";
  if (code === "email_not_confirmed") return "L'email non è ancora confermata: confermala in Supabase (Authentication → Users).";
  if (code === "email_provider_disabled") return "L'accesso con email e password è disattivato in Supabase (Authentication → Sign In / Providers → Email).";
  if (error.status === 401 || /api key/i.test(error.message ?? "")) return "Chiave di Supabase non valida in questo ambiente: controlla NEXT_PUBLIC_SUPABASE_ANON_KEY su Vercel.";
  if (code === "over_request_rate_limit" || error.status === 429) return "Troppi tentativi: riprova tra qualche minuto.";
  return `Accesso non riuscito (codice: ${code || error.status || "sconosciuto"}).`;
}

export async function signOut() {
  const config = studioConfig();
  if (config) await (await studioClient(config)).auth.signOut();
  redirect("/studio/login");
}

// ---------------------------------------------------------------- luoghi

export async function updatePlace(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const slug = text(form, "slug");
  const path = `${packPath(pack)}/luoghi/${encodeURIComponent(slug)}`;
  const labels: Record<string, { name: string; short: string }> = {};
  for (const locale of ["it", "en"]) {
    const name = text(form, `name_${locale}`);
    const short = text(form, `short_${locale}`);
    if (name) labels[locale] = { name, short };
    else if (short) back(path, { errore: `Manca il nome (${locale}) per la descrizione breve.` });
  }
  const patch: Record<string, unknown> = {
    labels,
    importance: Number(text(form, "importance")),
    dwellMin: Number(text(form, "dwellMin")),
    categories: text(form, "categories").split(",").map((c) => c.trim()).filter(Boolean),
    fieldNotes: text(form, "fieldNotes").split("\n").map((n) => n.trim()).filter(Boolean),
  };
  const lng = text(form, "lng");
  const lat = text(form, "lat");
  if (lng && lat && (lng !== text(form, "lng_before") || lat !== text(form, "lat_before"))) {
    const location = [Number(lng.replace(",", ".")), Number(lat.replace(",", "."))];
    if (!location.every(Number.isFinite)) back(path, { errore: "Coordinate non valide." });
    patch.location = location;
    patch.coordinateMethod = text(form, "coordinateMethod");
  }
  const { error } = await rpc(supabase, "studio_update_place", { p_pack: pack, p_slug: slug, p: patch });
  if (error) back(path, { errore: friendlyError(error) });
  revalidatePath(packPath(pack), "layout");
  back(path, { ok: "Luogo salvato." });
}

// ---------------------------------------------------------------- percorsi

export async function saveRouteStops(pack: string, slug: string, stops: { place: string; dwellMin: number | null; optional: boolean }[]) {
  const { supabase } = await requireStaff();
  const problem = checkStops(stops);
  if (problem) return { error: problem };
  const { error } = await rpc(supabase, "studio_set_route_stops", { p_pack: pack, p_slug: slug, p_stops: stops });
  if (error) return { error: friendlyError(error) };
  revalidatePath(packPath(pack), "layout");
  return { error: null };
}

// ---------------------------------------------------------------- revisione

export async function reviewAssertion(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const action = text(form, "action");
  const filter = text(form, "stato");
  const path = `${packPath(pack)}/affermazioni`;
  const keep = filter ? { stato: filter } : {};
  if (!["submit", "verify", "reject", "reopen"].includes(action)) back(path, { ...keep, errore: "Azione sconosciuta." });
  const { error } = await rpc(supabase, "studio_review_assertion", {
    p_pack: pack, p_slug: text(form, "slug"), p_action: action, p_note: text(form, "note") || null,
  });
  if (error) back(path, { ...keep, errore: friendlyError(error) });
  revalidatePath(packPath(pack), "layout");
  const done: Record<string, string> = { submit: "inviata in revisione", verify: "verificata", reject: "respinta", reopen: "riportata in revisione" };
  back(path, { ...keep, ok: `Affermazione ${done[action]}.` });
}

export async function confirmEvidence(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const filter = text(form, "stato");
  const path = `${packPath(pack)}/affermazioni`;
  const keep = filter ? { stato: filter } : {};
  const { error } = await rpc(supabase, "studio_confirm_evidence", {
    p_pack: pack, p_slug: text(form, "slug"), p_position: Number(text(form, "position")), p_locator: text(form, "locator"),
  });
  if (error) back(path, { ...keep, errore: friendlyError(error) });
  revalidatePath(packPath(pack), "layout");
  back(path, { ...keep, ok: "Fonte confermata." });
}

// ---------------------------------------------------------------- media

export interface RegisterMediaInput {
  pack: string;
  file: string;
  sha256: string;
  mimeType: string;
  bytes: number;
  altIt: string;
  altEn: string;
  captionIt: string;
  author: string;
  license: string;
  source: string;
  originalUrl: string;
  licenseNote: string;
  subjects: string[];
}

/** Registra nel database un'immagine appena caricata nel bucket (dal browser, con la sessione dell'utente). */
export async function registerMedia(input: RegisterMediaInput) {
  const { supabase } = await requireStaff();
  if (!(MEDIA_LICENSES as readonly string[]).includes(input.license)) return { error: "Licenza non valida." };
  if (!(MEDIA_SOURCES as readonly string[]).includes(input.source)) return { error: "Provenienza non valida." };
  const { error } = await rpc(supabase, "studio_register_media", {
    p_pack: input.pack,
    p: {
      file: input.file,
      sha256: input.sha256,
      mimeType: input.mimeType,
      bytes: input.bytes,
      alt: { it: input.altIt, en: input.altEn },
      caption: { it: input.captionIt },
      author: input.author,
      license: input.license,
      source: input.source,
      originalUrl: input.originalUrl,
      licenseNote: input.licenseNote,
      subjects: input.subjects,
    },
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath(packPath(input.pack), "layout");
  return { error: null };
}
