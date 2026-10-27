/**
 * Scheda «Avvisi» dello Studio (fase F2): avvisi operativi verificati, per esempio «sentiero chiuso per frana» o «solo
 * su prenotazione». Tipi, etichette e lettura del modulo; logica pura, testata. Decide il database
 * (migrazione 20261105000000: funzioni studio_*_operational_notice): qui si rifiutano subito i dati malformati e si
 * spiegano gli errori.
 *
 * Gli avvisi pubblicati e in vigore arrivano a Gaia, che da essi (e dalle informazioni pratiche valide) può dire lo
 * stato di oggi, citandoli con la loro fonte. Non fanno parte del Territory Pack né del bundle.
 */
import { addDays, daysBetween, isIsoDate } from "../local-events";

export const NOTICE_STATUSES = ["closed", "restricted", "booking_required", "caution", "open"] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];
export const NOTICE_STATUS_LABELS: Record<NoticeStatus, string> = {
  closed: "Chiuso o interdetto",
  restricted: "Aperto con limitazioni",
  booking_required: "Solo su prenotazione",
  caution: "Aperto con cautela",
  open: "Aperto o praticabile",
};

export const NOTICE_LIMITS = { title: 140, text: 600, days: 180 } as const;

export interface StudioNotice {
  id: string;
  pack: string;
  slug: string;
  status: NoticeStatus;
  labels: Record<string, { title?: string; text?: string }>;
  place: string | null;
  route: string | null;
  sourceUrl: string | null;
  validFrom: string;
  validUntil: string;
  /** Oggi nel fuso della destinazione, dal database. */
  today: string;
  publication: "draft" | "published" | "withdrawn";
  verifiedAt: string | null;
  verificationNote: string | null;
  publishedAt: string | null;
}

export type FormValues = Record<string, string>;
export type NoticeForm = (name: string) => string;

/** Dal modulo al formato di studio_save_operational_notice. */
export function noticePayloadFromForm(
  get: NoticeForm,
  locales: readonly string[],
  defaultLocale: string,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const value = (name: string) => get(name).replace(/\s+/g, " ").trim();
  const status = value("status");
  if (!(NOTICE_STATUSES as readonly string[]).includes(status)) return { ok: false, error: "Scegli lo stato dell'avviso." };
  const labels: Record<string, { title?: string; text?: string }> = {};
  for (const l of locales) {
    const title = value(`title_${l}`);
    const text = value(`text_${l}`);
    if (title.length > NOTICE_LIMITS.title) return { ok: false, error: `Titolo (${l}) troppo lungo: al massimo ${NOTICE_LIMITS.title} caratteri.` };
    if (text.length > NOTICE_LIMITS.text) return { ok: false, error: `Testo (${l}) troppo lungo: al massimo ${NOTICE_LIMITS.text} caratteri.` };
    if (title || text) labels[l] = { ...(title ? { title } : {}), ...(text ? { text } : {}) };
  }
  if (!labels[defaultLocale]?.title) return { ok: false, error: `Scrivi il titolo nella lingua principale (${defaultLocale}).` };
  const validFrom = value("validFrom");
  const validUntil = value("validUntil");
  if (!isIsoDate(validFrom) || !isIsoDate(validUntil)) return { ok: false, error: "Indica da quando e fino a quando vale l'avviso." };
  const span = daysBetween(validFrom, validUntil);
  if (span < 0) return { ok: false, error: "La fine della validità viene prima dell'inizio." };
  if (span > NOTICE_LIMITS.days) return { ok: false, error: `Un avviso vale al massimo ${NOTICE_LIMITS.days} giorni: per periodi più lunghi usa le informazioni pratiche del luogo.` };
  const place = value("place");
  const route = value("route");
  if (place && route) return { ok: false, error: "Un avviso riguarda un luogo o un percorso, non entrambi." };
  const sourceUrl = value("sourceUrl");
  if (sourceUrl && !/^https:\/\/[^\s]+$/.test(sourceUrl)) return { ok: false, error: "La fonte deve essere un indirizzo che inizia con https://." };
  const slug = value("slug");
  return {
    ok: true,
    payload: {
      status,
      labels,
      validFrom,
      validUntil,
      ...(place ? { place } : {}),
      ...(route ? { route } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(slug ? { slug } : {}),
    },
  };
}

/** Dall'avviso ai valori del modulo. */
export function formValuesFromNotice(n: StudioNotice, locales: readonly string[]): FormValues {
  const v: FormValues = {
    status: n.status,
    validFrom: n.validFrom,
    validUntil: n.validUntil,
    place: n.place ?? "",
    route: n.route ?? "",
    sourceUrl: n.sourceUrl ?? "",
  };
  for (const l of locales) {
    v[`title_${l}`] = n.labels[l]?.title ?? "";
    v[`text_${l}`] = n.labels[l]?.text ?? "";
  }
  return v;
}

/** Valori iniziali di un avviso nuovo: da oggi per una settimana. */
export const newNoticeValues = (today: string): FormValues => ({ validFrom: today, validUntil: addDays(today, 7) });

export const noticeTitle = (n: Pick<StudioNotice, "labels" | "slug">, defaultLocale: string) =>
  n.labels[defaultLocale]?.title ?? Object.values(n.labels).find((l) => l.title)?.title ?? n.slug;

/** In vigore oggi, futuro o scaduto (nel fuso della destinazione). */
export function noticeTiming(n: Pick<StudioNotice, "validFrom" | "validUntil" | "today">): "current" | "future" | "expired" {
  if (n.validUntil < n.today) return "expired";
  if (n.validFrom > n.today) return "future";
  return "current";
}

/** Cosa manca per pubblicare (lo ricontrolla il database). */
export function noticePublishBlockers(n: Pick<StudioNotice, "sourceUrl" | "verifiedAt" | "validUntil" | "today">): string[] {
  const out: string[] = [];
  if (!n.sourceUrl) out.push("manca l'indirizzo della fonte ufficiale");
  else if (!n.verifiedAt) out.push("la fonte non è ancora stata verificata");
  if (n.validUntil < n.today) out.push("l'avviso è già scaduto");
  return out;
}

/** Viste dell'elenco: in vigore o in arrivo (non ritirati), bozze, pubblicati, ritirati, scaduti. */
export const NOTICE_VIEWS = ["attivi", "bozze", "pubblicati", "ritirati", "scaduti"] as const;
export type NoticeView = (typeof NOTICE_VIEWS)[number];
export const NOTICE_VIEW_LABELS: Record<NoticeView, string> = {
  attivi: "In vigore e in arrivo",
  bozze: "Bozze",
  pubblicati: "Pubblicati",
  ritirati: "Ritirati",
  scaduti: "Scaduti",
};
export const isNoticeView = (v: unknown): v is NoticeView => typeof v === "string" && (NOTICE_VIEWS as readonly string[]).includes(v);

export function inNoticeView(n: StudioNotice, view: NoticeView): boolean {
  const expired = noticeTiming(n) === "expired";
  switch (view) {
    case "attivi":
      return !expired && n.publication !== "withdrawn";
    case "bozze":
      return n.publication === "draft";
    case "pubblicati":
      return n.publication === "published";
    case "ritirati":
      return n.publication === "withdrawn";
    case "scaduti":
      return expired;
  }
}
