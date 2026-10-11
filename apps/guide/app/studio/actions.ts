"use server";
/**
 * Azioni dello Studio. Ognuna verifica di nuovo l'utente (requireStaff) e passa dal database con la
 * sua identità: permessi, quattro occhi e storico li applicano le funzioni studio_* e le policy RLS.
 * L'esito torna nella pagina come messaggio (?ok= / ?errore=).
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { checkReadiness, requireStaff, rpc, studioClient, studioConfig } from "../../lib/studio/server";
import { afterDeleteHref, checkMediaRights, checkStops, DELETE_KINDS, filesInPack, friendlyError, isDeleteKind, MEDIA_BUCKET, MEDIA_LICENSES, MEDIA_SOURCES } from "../../lib/studio/shared";

const back = (path: string, result: Record<string, string | undefined>): never => {
  const q = new URLSearchParams(Object.entries(result).filter((e): e is [string, string] => e[1] !== undefined)).toString();
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

function loginError(error: { code?: string; status?: number; message?: string; name?: string }): string {
  const code = error.code ?? "";
  if (code === "invalid_credentials" || /invalid login credentials/i.test(error.message ?? "")) return "Email o password non corrette.";
  if (code === "email_not_confirmed") return "L'email non è ancora confermata: confermala in Supabase (Authentication → Users).";
  if (code === "email_provider_disabled") return "L'accesso con email e password è disattivato in Supabase (Authentication → Sign In / Providers → Email).";
  if (error.status === 401 || /api key/i.test(error.message ?? "")) return "Chiave di Supabase non valida in questo ambiente: controlla NEXT_PUBLIC_SUPABASE_ANON_KEY su Vercel.";
  if (code === "over_request_rate_limit" || error.status === 429) return "Troppi tentativi: riprova tra qualche minuto.";
  // Senza codice né stato di solito la richiesta non è arrivata a Supabase (indirizzo sbagliato, rete).
  const detail = [error.name, error.status ? `HTTP ${error.status}` : "", (error.message ?? "").slice(0, 160)].filter(Boolean).join(" · ");
  if (!code && !error.status) {
    return `Supabase non raggiungibile da questo ambiente: controlla NEXT_PUBLIC_SUPABASE_URL su Vercel (deve essere https://<id-progetto>.supabase.co). Dettaglio: ${detail || "nessuno"}.`;
  }
  return `Accesso non riuscito (codice: ${code || error.status}). Dettaglio: ${detail}.`;
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
  const rights = checkMediaRights(input);
  if (rights) return { error: rights };
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

// ---------------------------------------------------------------- territori

const texts = (form: FormData, name: string) => ({ it: text(form, `${name}_it`), en: text(form, `${name}_en`) });
const list = (form: FormData, name: string) => form.getAll(name).map(String).map((v) => v.trim()).filter(Boolean);

export async function createPack(form: FormData) {
  const { supabase } = await requireStaff();
  const id = text(form, "id");
  const { error } = await rpc(supabase, "studio_create_pack", {
    p: {
      id,
      kind: text(form, "kind"),
      title: texts(form, "title"),
      description: texts(form, "description"),
      defaultLocale: text(form, "defaultLocale"),
      locales: list(form, "locales"),
      releaseStage: text(form, "releaseStage") || "research",
      dependsOn: list(form, "dependsOn"),
      ...(text(form, "organizationId") ? { organizationId: text(form, "organizationId") } : {}),
    },
  });
  if (error) back("/studio/nuovo", { errore: friendlyError(error) });
  revalidatePath("/studio", "layout");
  back(`${packPath(id)}/panoramica`, {
    ok: text(form, "kind") === "destination"
      ? "Destinazione creata in bozza. Ora aggiungi luoghi, fonti, affermazioni e racconti."
      : "Territorio creato. È un contenitore: ora crea le destinazioni al suo interno.",
  });
}

export async function updatePack(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const path = `${packPath(pack)}/panoramica`;
  const patch: Record<string, unknown> = {
    title: texts(form, "title"),
    description: texts(form, "description"),
    defaultLocale: text(form, "defaultLocale"),
    locales: list(form, "locales"),
    releaseStage: text(form, "releaseStage"),
    dependsOn: list(form, "dependsOn"),
  };
  if (form.has("cover")) patch.cover = text(form, "cover") || null;
  const { error } = await rpc(supabase, "studio_update_pack", { p_pack: pack, p: patch });
  if (error) back(path, { errore: friendlyError(error) });
  revalidatePath("/studio", "layout");
  back(path, { ok: "Territorio salvato." });
}

/** Cambio di stato. Per pubblicare rifà il controllo completo sul server e lo registra con la richiesta. */
export async function setPackStatus(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const status = text(form, "status");
  const path = `${packPath(pack)}/panoramica`;
  let report: unknown = null;
  if (status === "published") {
    const r = await checkReadiness(supabase, pack);
    if (!r.ok) back(path, { controllo: "1", errore: `Il controllo di pubblicazione non è superato (${r.errors.length} errori): correggili prima di pubblicare.` });
    report = { ok: r.ok, checkedAt: r.checkedAt, errors: r.errors, warnings: r.warnings.length, bundles: r.bundles };
  }
  const { error } = await rpc(supabase, "studio_set_pack_status", { p_pack: pack, p_status: status, p_report: report });
  if (error) back(path, { errore: friendlyError(error) });
  revalidatePath("/studio", "layout");
  const done: Record<string, string> = {
    in_review: "Territorio in revisione.",
    draft: "Territorio riportato in bozza.",
    published: "Pubblicazione approvata e richiesta registrata. Arriverà nell'app con la pipeline di pubblicazione.",
  };
  back(path, { ok: done[status] ?? "Stato aggiornato." });
}

// ---------------------------------------------------------------- nuovi contenuti

const numberOr = (v: string, fallback?: number) => (v === "" ? fallback : Number(v.replace(",", ".")));

export async function createPlace(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const location = [numberOr(text(form, "lng")), numberOr(text(form, "lat"))];
  if (!location.every((n) => typeof n === "number" && Number.isFinite(n))) back(`${packPath(pack)}/luoghi/nuovo`, { errore: "Coordinate non valide." });
  const { data, error } = await rpc<{ slug: string }>(supabase, "studio_create_place", {
    p_pack: pack,
    p: {
      name: texts(form, "name"),
      short: texts(form, "short"),
      placeKind: text(form, "placeKind"),
      categories: text(form, "categories").split(",").map((c) => c.trim()).filter(Boolean),
      location,
      coordinateMethod: text(form, "coordinateMethod"),
      importance: numberOr(text(form, "importance"), 3),
      dwellMin: numberOr(text(form, "dwellMin"), 10),
      radiusM: numberOr(text(form, "radiusM"), 40),
    },
  });
  if (error || !data) back(`${packPath(pack)}/luoghi/nuovo`, { errore: friendlyError(error) });
  revalidatePath(packPath(pack), "layout");
  back(`${packPath(pack)}/luoghi/${encodeURIComponent(data!.slug)}`, { ok: "Luogo creato." });
}

export async function createSource(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const path = `${packPath(pack)}/fonti`;
  const { error } = await rpc(supabase, "studio_create_source", {
    p_pack: pack,
    p: {
      title: text(form, "title"),
      sourceKind: text(form, "sourceKind"),
      authors: text(form, "authors").split(",").map((a) => a.trim()).filter(Boolean),
      institution: text(form, "institution"),
      year: text(form, "year"),
      url: text(form, "url"),
      reliability: text(form, "reliability"),
      language: text(form, "language"),
    },
  });
  if (error) back(path, { errore: friendlyError(error) });
  revalidatePath(packPath(pack), "layout");
  back(path, { ok: "Fonte aggiunta." });
}

export async function createAssertion(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const path = `${packPath(pack)}/affermazioni`;
  const source = text(form, "source");
  const { error } = await rpc(supabase, "studio_create_assertion", {
    p_pack: pack,
    p: {
      subject: text(form, "subject"),
      type: text(form, "type"),
      certainty: text(form, "certainty"),
      texts: texts(form, "text"),
      evidence: source ? [{ source, locator: text(form, "locator") }] : [],
      submit: text(form, "submit") === "1",
    },
  });
  if (error) back(path, { stato: "draft", errore: friendlyError(error) });
  revalidatePath(packPath(pack), "layout");
  back(path, { stato: text(form, "submit") === "1" ? "in_review" : "draft", ok: "Affermazione creata." });
}

export async function createUnit(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const path = `${packPath(pack)}/racconti`;
  const { error } = await rpc(supabase, "studio_create_unit", {
    p_pack: pack,
    p: {
      anchor: text(form, "anchor"),
      unitType: text(form, "unitType"),
      locale: text(form, "locale"),
      durationS: numberOr(text(form, "durationS"), 30),
      text: text(form, "text"),
      assertions: list(form, "assertions"),
    },
  });
  if (error) back(path, { errore: friendlyError(error) });
  revalidatePath(packPath(pack), "layout");
  back(path, { ok: "Racconto creato." });
}

export async function createRoute(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const { data, error } = await rpc<{ slug: string }>(supabase, "studio_create_route", {
    p_pack: pack,
    p: { name: texts(form, "name"), durationMin: numberOr(text(form, "durationMin"), 0), stops: list(form, "stops").map((place) => ({ place })) },
  });
  if (error || !data) back(`${packPath(pack)}/percorsi`, { errore: friendlyError(error) });
  revalidatePath(packPath(pack), "layout");
  back(`${packPath(pack)}/percorsi/${encodeURIComponent(data!.slug)}`, { ok: "Percorso creato: ora ordina le tappe." });
}

// ---------------------------------------------------------------- eliminazione

/**
 * Elimina un elemento o un territorio dopo la pagina di conferma. Il database controlla di nuovo
 * permessi e blocchi e salva prima una copia del territorio; poi si tolgono dal bucket i file rimasti
 * senza media, con la sessione dell'utente (policy di Storage).
 */
export async function deleteItem(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const kind = text(form, "kind");
  const slug = text(form, "slug");
  if (!isDeleteKind(kind)) back("/studio", { errore: "Tipo da eliminare non valido." });
  const k = kind as keyof typeof DELETE_KINDS;
  const { data, error } = k === "pack"
    ? await rpc<{ files?: unknown }>(supabase, "studio_delete_pack", { p_pack: pack, p_confirm: text(form, "confirm") })
    : await rpc<{ files?: unknown }>(supabase, "studio_delete", { p_pack: pack, p_kind: k, p_slug: slug });
  if (error) back(`${packPath(pack)}/elimina`, { tipo: k, slug: slug || undefined, errore: friendlyError(error) });

  let files = filesInPack(pack, data?.files);
  if (k === "pack") {
    // Anche i file caricati e mai registrati: la cartella del territorio si svuota.
    const listed = await supabase.storage.from(MEDIA_BUCKET).list(pack, { limit: 1000 });
    files = [...new Set([...files, ...filesInPack(pack, (listed.data ?? []).map((f) => `${pack}/${f.name}`))])];
  }
  let note = "";
  if (files.length > 0) {
    const removed = await supabase.storage.from(MEDIA_BUCKET).remove(files);
    if (removed.error) note = ` I file nel bucket non sono stati tolti (${removed.error.message}): si possono togliere dal pannello di Supabase.`;
  }
  revalidatePath("/studio", "layout");
  back(afterDeleteHref(pack, k), {
    ok: `${DELETE_KINDS[k].done}${k === "pack" ? ` (${pack})` : ""}. Una copia del territorio com'era prima è salvata nello storico.${note}`,
  });
}
