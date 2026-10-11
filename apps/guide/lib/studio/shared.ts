/**
 * Studio: regole pure condivise tra server e browser (testate in test/studio.test.ts).
 * Le stesse regole valgono nel database (supabase/migrations/20261017000000_studio.sql): qui servono
 * a dare un messaggio subito, non a proteggere.
 */

/** Configurazione pubblica di Supabase: indirizzo del progetto e chiave pubblica (protetta dalle policy RLS). */
export interface StudioConfig {
  url: string;
  anonKey: string;
}

export function readStudioConfig(env: Record<string, string | undefined>): StudioConfig | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  // https sempre; http solo in locale (prove con un Supabase locale).
  if (!url || !anonKey || !/^(https:\/\/[^/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(url.replace(/\/$/, ""))) return null;
  return { url: url.replace(/\/$/, ""), anonKey };
}

export const MEDIA_BUCKET = "media";
export const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
/** Stesso limite del vincolo su media_assets per le immagini. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export const MEDIA_LICENSES = [
  "own", "public-domain", "cc0", "cc-by-4.0", "cc-by-sa-4.0", "cc-by-nc-4.0", "cc-by-nc-sa-4.0", "licensed", "all-rights-reserved",
] as const;
export const MEDIA_SOURCES = ["own_photo", "institution", "archive", "web", "other"] as const;

/** Controllo del file prima del caricamento: formato e dimensione. */
export function checkImage(file: { type: string; size: number }): string | null {
  if (!IMAGE_TYPES[file.type]) return "Formato non ammesso: solo JPEG, PNG o WebP.";
  if (file.size <= 0) return "Il file è vuoto.";
  if (file.size > MAX_IMAGE_BYTES) return `Il file supera ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`;
  return null;
}

/**
 * Diritti della foto: le stesse regole dei vincoli di media_assets, dette prima del caricamento
 * (il database le impone comunque, ma senza un messaggio leggibile).
 */
export function checkMediaRights(m: { author: string; license: string; source: string; originalUrl: string; licenseNote: string }): string | null {
  if (m.license !== "public-domain" && !m.author.trim()) return "Indica l'autore della foto (si può omettere solo per il pubblico dominio).";
  if (m.license === "licensed" && !m.licenseNote.trim()) return "Per una licenza concessa per iscritto indica il riferimento all'accordo.";
  if (m.source === "web" && !m.originalUrl.trim()) return "Per una foto presa dal web indica l'indirizzo originale.";
  return null;
}

/** Nome del file nel bucket: minuscole, cifre e trattini, con un suffisso che evita le sovrascritture. */
export function storageFileName(original: string, type: string, suffix: string): string {
  const base = original
    .replace(/\.[^.]*$/, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "immagine";
  return `${base}-${suffix}.${IMAGE_TYPES[type] ?? "jpg"}`;
}

export interface Stop {
  place: string;
  name: string;
  dwellMin: number | null;
  optional: boolean;
}

/** Sposta una tappa di una posizione (su: -1, giù: +1). Fuori dai limiti non cambia nulla. */
export function moveStop<T>(stops: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= stops.length || to < 0 || to >= stops.length) return [...stops];
  const next = [...stops];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

/** Tappe da salvare: almeno una, nessun luogo ripetuto, soste tra 1 e 240 minuti. */
export function checkStops(stops: readonly Pick<Stop, "place" | "dwellMin">[]): string | null {
  if (stops.length === 0) return "Un percorso ha almeno una tappa.";
  if (new Set(stops.map((s) => s.place)).size !== stops.length) return "Un luogo compare due volte tra le tappe.";
  if (stops.some((s) => s.dwellMin !== null && (!Number.isInteger(s.dwellMin) || s.dwellMin < 1 || s.dwellMin > 240))) {
    return "La sosta va da 1 a 240 minuti.";
  }
  return null;
}

/** Testo dell'errore da mostrare: il messaggio del database se è nostro (in italiano), altrimenti uno generico. */
export function friendlyError(error: { message?: string; code?: string } | null | undefined): string {
  const message = error?.message?.trim() ?? "";
  if (error?.code === "PGRST301" || /JWT|jwt/.test(message)) return "La sessione è scaduta: accedi di nuovo.";
  if (/^[a-zàèéìòù'"]/i.test(message) && !/violates|syntax|function .* does not exist|column/.test(message)) return message;
  return "Operazione non riuscita. Riprova; se continua, segnalalo con l'ora esatta.";
}

export const STATUS_LABELS: Record<string, string> = {
  draft: "Bozza",
  in_review: "In revisione",
  verified: "Verificata",
  rejected: "Respinta",
  deprecated: "Superata",
  blocked: "Bloccata",
};

export const ROLE_LABELS: Record<string, string> = {
  platform_admin: "Amministratore",
  platform_editor: "Redazione",
  territory_editor: "Editor del territorio",
  expert: "Esperto",
  institution: "Istituzione",
  contributor: "Collaboratore",
  translator: "Traduttore",
};

export const COORDINATE_LABELS: Record<string, string> = {
  preliminary: "coordinate preliminari",
  map_verified: "verificate su mappa",
  field_verified: "verificate sul posto",
  needs_review: "da ricontrollare",
};

/** Come studio_slugify nel database: «Chiesa di San Pietro» → «chiesa-di-san-pietro». */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Identificativo proposto per un nuovo territorio: quello del territorio che lo contiene + il nome. */
export function suggestPackId(parent: string, name: string): string {
  const slug = slugify(name);
  if (!slug) return parent ? `${parent}.` : "";
  return parent ? `${parent}.${slug}` : slug;
}

export const PACK_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$/;

/** L'identificativo rientra negli ambiti dell'utente? (stessa regola di can_edit_pack) */
export function withinScopes(id: string, anywhere: boolean, scopes: readonly string[]): boolean {
  return anywhere || scopes.some((s) => id === s || id.startsWith(`${s}.`));
}
