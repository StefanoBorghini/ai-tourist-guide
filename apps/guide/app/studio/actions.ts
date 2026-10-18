"use server";
/**
 * Azioni dello Studio. Ognuna verifica di nuovo l'utente (requireStaff) e passa dal database con la
 * sua identità: permessi, quattro occhi e storico li applicano le funzioni studio_* e le policy RLS.
 * L'esito torna nella pagina come messaggio (?ok= / ?errore=).
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { checkReadiness, refreshPublicIndex, requireStaff, rpc, runPublication, signedMediaUrls, studioClient, studioConfig, type PublicationResult } from "../../lib/studio/server";
import { copyRepoMedia } from "../../lib/studio/repo-media";
import { formatEuro, parseEuro, PLACE_DEFAULT_CENTS, priceProblem } from "../../lib/studio/catalog";
import { premiumBlockedByStatic } from "../../lib/static-bundles";
import { staticDestinations } from "../../lib/static-index";
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

/** Contenuti a pagamento della destinazione: li decide l'amministratore (lo verifica il database). */
export async function setAccess(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const path = `${packPath(pack)}/vendita`;
  const explore = text(form, "explore") === "premium" ? "premium" : "free";
  const introPlaces = list(form, "introPlaces");
  const premiumRoutes = list(form, "premiumRoutes");
  if (introPlaces.length > 3) back(path, { errore: "Al massimo 3 luoghi introduttivi." });
  // Le destinazioni con bundle compilati dai file non possono avere contenuti a pagamento (lo ricontrolla la pubblicazione).
  const blocked = explore === "premium" || premiumRoutes.length > 0 ? premiumBlockedByStatic(pack, await staticDestinations()) : null;
  if (blocked) back(path, { errore: `Non salvato: ${blocked}.` });
  const { error } = await rpc(supabase, "studio_set_access", {
    p_pack: pack,
    p: { explore, introPlaces, premiumRoutes },
  });
  if (error) back(path, { errore: friendlyError(error) });
  revalidatePath("/studio", "layout");
  back(path, { ok: "Accesso salvato. Nell'app cambia alla prossima pubblicazione." });
}

// ---------------------------------------------------------------- catalogo (solo amministratore, regole nel database)

export async function saveProduct(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const path = `${packPath(pack)}/vendita`;
  const id = text(form, "id");
  const p = {
    ...(id ? { id } : { kind: text(form, "kind"), route: text(form, "route") || undefined }),
    name: { it: text(form, "name_it"), en: text(form, "name_en") },
    description: { it: text(form, "description_it"), en: text(form, "description_en") },
    status: text(form, "status") || "draft",
    availability: text(form, "availability") || "available",
    sortOrder: Number(text(form, "sort_order") || "0") || 0,
    // Solo i pacchetti hanno un elenco di percorsi (anche vuoto, se si tolgono tutti).
    ...(form.get("bundle") === "1" || (!id && text(form, "kind") === "bundle") ? { routes: list(form, "routes") } : {}),
  };
  const { error } = await rpc(supabase, "studio_product_save", { p_pack: pack, p });
  if (error) back(path, { errore: friendlyError(error) });
  revalidatePath(path);
  back(path, { ok: p.status === "active" ? "Prodotto salvato e attivo." : "Prodotto salvato." });
}

export async function setDraftPrice(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const path = `${packPath(pack)}/vendita`;
  const clear = form.get("clear") === "1";
  const cents = clear ? null : parseEuro(text(form, "price"));
  if (!clear) {
    const problem = priceProblem(cents);
    if (problem) back(path, { errore: problem });
  }
  const { error } = await rpc(supabase, "studio_price_draft", { p_product: text(form, "product"), p_amount: cents });
  if (error) back(path, { errore: friendlyError(error) });
  revalidatePath(path);
  back(path, { ok: clear ? "Bozza del prezzo tolta." : `Prezzo in bozza: ${formatEuro(cents!)}. Vale solo dopo «Pubblica i prezzi».` });
}

/** Crea i prodotti dei singoli luoghi vendibili ancora senza prodotto, con il prezzo in bozza indicato (0,50 € se vuoto). */
export async function placesOnSale(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const path = `${packPath(pack)}/vendita`;
  const cents = text(form, "price") ? parseEuro(text(form, "price")) : PLACE_DEFAULT_CENTS;
  const problem = priceProblem(cents);
  if (problem) back(path, { errore: problem });
  const { data, error } = await rpc<number>(supabase, "studio_places_on_sale", { p_pack: pack, p_amount: cents });
  if (error) back(path, { errore: friendlyError(error) });
  revalidatePath(path);
  back(path, {
    ok: data ? `Creati ${data} prodotti «Luogo» a ${formatEuro(cents!)} in bozza: valgono dopo «Pubblica i prezzi».` : "Tutti i luoghi vendibili hanno già un prodotto.",
  });
}

export async function publishPrices(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const path = `${packPath(pack)}/vendita`;
  const { data, error } = await rpc<number>(supabase, "studio_prices_publish", { p_pack: pack });
  if (error) back(path, { errore: friendlyError(error) });
  revalidatePath(path);
  back(path, { ok: `Pubblicati ${data} prezzi: il listino pubblico li mostra subito.` });
}

/** Cambio di stato. Per pubblicare rifà il controllo completo sul server e lo registra con la richiesta. */
/** Messaggio dell'esito di una pubblicazione, per la pagina del territorio. */
function publicationMessage(r: PublicationResult): Record<string, string> {
  if (!r.ok) return { errore: `Pubblicazione non riuscita: ${r.errors.slice(0, 3).join("; ")}. La versione nell'app resta quella di prima.` };
  const bundles = r.bundles.map((b) => `${b.locale} ${(b.totalBytes / 1024 / 1024).toFixed(1)} MB`).join(", ");
  return { ok: `Pubblicato: il territorio è nell'app (${bundles}).${r.warnings.length ? ` Avvisi: ${r.warnings.length}.` : ""}` };
}

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
  const before = await rpc<{ status: string | null }>(supabase, "studio_pack", { p_pack: pack });
  const { error } = await rpc(supabase, "studio_set_pack_status", { p_pack: pack, p_status: status, p_report: report });
  if (error) back(path, { errore: friendlyError(error) });
  revalidatePath("/studio", "layout");
  if (status === "published") back(path, publicationMessage(await runPublication(supabase, pack)));
  if (before.data?.status === "published") {
    // Ritiro: l'indice pubblico si ricalcola senza questo territorio.
    const indexError = await refreshPublicIndex(supabase);
    back(path, indexError
      ? { errore: `Pubblicazione ritirata nel database, ma l'indice dell'app non è stato aggiornato: ${indexError}` }
      : { ok: "Pubblicazione ritirata: il territorio non compare più nell'app (chi l'ha già scaricato lo conserva)." });
  }
  const done: Record<string, string> = {
    in_review: "Territorio in revisione.",
    draft: "Territorio riportato in bozza.",
  };
  back(path, { ok: done[status] ?? "Stato aggiornato." });
}

/** Ripubblica un territorio già in linea, per portare nell'app le modifiche fatte dopo. */
export async function republishPack(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const path = `${packPath(pack)}/panoramica`;
  const r = await checkReadiness(supabase, pack);
  if (!r.ok) back(path, { controllo: "1", errore: `Il controllo di pubblicazione non è superato (${r.errors.length} errori): correggili prima di ripubblicare.` });
  const { error } = await rpc(supabase, "studio_request_publication", {
    p_pack: pack,
    p_report: { ok: r.ok, checkedAt: r.checkedAt, errors: r.errors, warnings: r.warnings.length, bundles: r.bundles },
  });
  if (error) back(path, { errore: friendlyError(error) });
  revalidatePath("/studio", "layout");
  back(path, publicationMessage(await runPublication(supabase, pack)));
}

/** Copia nel bucket «media» i file dei media importati dai file del repository (stessa impronta). */
export async function copyMediaFromRepository(form: FormData) {
  const { supabase } = await requireStaff();
  const pack = text(form, "pack");
  const path = `${packPath(pack)}/media`;
  const { data: snap, error } = await rpc<{ media?: { file: string; poster?: string; sha256?: string }[] }>(supabase, "pack_snapshot", { p_pack: pack });
  if (error || !snap) back(path, { errore: error ? friendlyError(error) : "Territorio non leggibile." });
  const media = snap!.media ?? [];
  const paths = media.flatMap((m) => [m.file, ...(m.poster ? [m.poster] : [])]).map((f) => `${pack}/${f}`);
  const inBucket = new Set((await signedMediaUrls(supabase, paths)).keys());
  const r = await copyRepoMedia(supabase, pack, media, inBucket);
  revalidatePath(path);
  const parts = [
    r.copied.length ? `${r.copied.length} file copiati nel bucket` : "Nessun file da copiare",
    r.missing.length ? `non trovati nel repository: ${r.missing.join(", ")}` : "",
    r.failed.length ? `non riusciti: ${r.failed.join("; ")}` : "",
  ].filter(Boolean).join(". ");
  back(path, r.failed.length || r.missing.length ? { errore: `${parts}.` } : { ok: `${parts}.` });
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
