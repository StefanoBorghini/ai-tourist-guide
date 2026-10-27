/**
 * Avvisi operativi verificati nelle domande a Gaia (fase F2): lettura della risposta di `public_operational_notices()`
 * (migrazione 20261105000000), righe del messaggio e riferimenti citabili. Logica pura, testata, senza rete né AI.
 *
 * Un avviso è un dato operativo con una fonte https, verificato e pubblicato dalla redazione nello Studio, valido in un
 * intervallo di date: «sentiero chiuso per frana», «solo su prenotazione». Sta fuori dal Territory Pack e dal bundle
 * (cambia di giorno in giorno) e arriva al modello solo nel messaggio della domanda, mai nella base in cache.
 *
 * È l'unica fonte, oltre alle informazioni pratiche valide, da cui Gaia può dire lo stato di oggi; il modello lo cita
 * con `op:<slug>`. Nessun avviso non vuol dire «tutto aperto»: lo dice il messaggio e lo impone il controllo.
 */
import { z } from "zod";
import { isIsoDate } from "./local-events";

/** Prefisso dei riferimenti degli avvisi nelle citazioni. */
export const NOTICE_PREFIX = "op:";

export const NOTICE_STATUSES = ["open", "closed", "restricted", "booking_required", "caution"] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];

const STATUS_LABEL: Record<NoticeStatus, string> = {
  open: "aperto o praticabile",
  closed: "chiuso o interdetto",
  restricted: "aperto con limitazioni",
  booking_required: "solo su prenotazione",
  caution: "aperto con cautela",
};

const isoDate = z.string().refine(isIsoDate);
const SUBJECT = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;

const noticeSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  status: z.enum(NOTICE_STATUSES),
  title: z.string().min(1).max(140),
  text: z.string().max(600).nullish(),
  place: z.string().regex(SUBJECT).nullish(),
  route: z.string().regex(SUBJECT).nullish(),
  sourceUrl: z.string().max(2000).regex(/^https:\/\/[^\s]+$/),
  validFrom: isoDate,
  validUntil: isoDate,
  verifiedAt: z.string().min(10),
});

const payloadSchema = z.object({ territory: z.string(), today: isoDate, notices: z.array(z.unknown()).max(200) });

export interface OperationalNotice {
  ref: string;
  status: NoticeStatus;
  title: string;
  text?: string;
  place?: string;
  route?: string;
  sourceUrl: string;
  validFrom: string;
  validUntil: string;
  /** AAAA-MM-GG: giorno della verifica della redazione. */
  verifiedOn: string;
}

/**
 * Avvisi della destinazione per la domanda:
 * - `ok`: letti adesso (o da meno di un minuto); `notices` può essere vuoto;
 * - `unavailable`: il servizio non ha risposto in tempo o ha dato errore: non si sa se ce ne sono.
 * Assenti (undefined) quando la destinazione non li prevede (Supabase non configurato, bundle dai file).
 */
export type NoticeSet = { state: "ok"; today: string; notices: OperationalNotice[] } | { state: "unavailable" };

/**
 * Risposta della funzione pubblica → avvisi. Null se non è una risposta valida per quel territorio (si tratta come
 * servizio non disponibile). Un avviso malformato si scarta da solo, gli altri restano; uno non in vigore a `today`
 * (la funzione già li filtra) si scarta comunque.
 */
export function parseNotices(data: unknown, pack: string): NoticeSet | null {
  const payload = payloadSchema.safeParse(data);
  if (!payload.success || payload.data.territory !== pack) return null;
  const today = payload.data.today;
  const notices: OperationalNotice[] = [];
  const seen = new Set<string>();
  for (const raw of payload.data.notices) {
    const n = noticeSchema.safeParse(raw);
    if (!n.success || seen.has(n.data.slug)) continue;
    const v = n.data;
    if (v.validFrom > today || v.validUntil < today || (v.place && v.route)) continue;
    seen.add(v.slug);
    notices.push({
      ref: `${NOTICE_PREFIX}${v.slug}`,
      status: v.status,
      title: v.title.trim(),
      ...(v.text?.trim() ? { text: v.text.trim() } : {}),
      ...(v.place ? { place: v.place } : {}),
      ...(v.route ? { route: v.route } : {}),
      sourceUrl: v.sourceUrl,
      validFrom: v.validFrom,
      validUntil: v.validUntil,
      verifiedOn: v.verifiedAt.slice(0, 10),
    });
  }
  return { state: "ok", today, notices };
}

/**
 * Parte della chiave della cache delle risposte (che la riduce a un hash): un avviso nuovo, cambiato o ritirato cambia
 * la risposta. Niente crypto qui: il modulo arriva anche nel browser.
 */
export function noticesKey(set: NoticeSet | undefined): string {
  if (!set) return "";
  if (set.state === "unavailable") return "op:unavailable";
  return JSON.stringify(set.notices);
}

const NUMBER = /\d+(?:[.,]\d+)?/g;
const dateNumbers = (date: string) => date.split("-").flatMap((part) => [part, String(Number(part))]);

/** Numeri che una risposta può ripetere citando l'avviso: quelli del titolo e del testo e le date di validità e verifica. */
export function noticeNumbers(n: OperationalNotice): string[] {
  const fromText = [...`${n.title} ${n.text ?? ""}`.matchAll(NUMBER)].map((m) => m[0].replace(",", "."));
  return [...new Set([...fromText, ...dateNumbers(n.validFrom), ...dateNumbers(n.validUntil), ...dateNumbers(n.verifiedOn)])];
}

/** Riga dell'avviso nel messaggio della domanda (senza il riferimento). `name` dà il nome di un luogo o percorso. */
export function noticeLine(n: OperationalNotice, name: (ref: string) => string): string {
  const subject = n.place ? `luogo: ${name(n.place)}` : n.route ? `percorso: ${name(n.route)}` : "tutta la destinazione";
  return [
    subject,
    `stato: ${STATUS_LABEL[n.status]}`,
    n.title,
    ...(n.text ? [n.text] : []),
    `valido dal ${n.validFrom} al ${n.validUntil}`,
    `verificato dalla redazione il ${n.verifiedOn}`,
    `fonte: ${n.sourceUrl}`,
  ].join(" | ");
}

/** Righe degli avvisi nel CONTESTO del messaggio; nessuna riga se la destinazione non li prevede. */
export function noticesContext(set: NoticeSet | undefined, name: (ref: string) => string): string[] {
  if (!set) return [];
  if (set.state === "unavailable") {
    return ["", "AVVISI OPERATIVI: non disponibili in questo momento (non si sa se ce ne sono). Lo stato di oggi non è verificabile da qui."];
  }
  if (set.notices.length === 0) {
    return ["", "AVVISI OPERATIVI in vigore oggi: nessuno. Non vuol dire che tutto sia aperto: lo stato di oggi resta da verificare."];
  }
  return [
    "",
    "AVVISI OPERATIVI (verificati dalla redazione, con fonte, in vigore oggi; si citano con il primo campo; prevalgono sulle informazioni pratiche)",
    ...set.notices.map((n) => `- ${n.ref} | ${noticeLine(n, name)}`),
  ];
}

/** Avvisi citati in una risposta, per mostrarne la fonte all'utente. */
export const citedNotices = (set: NoticeSet | undefined, citations: readonly string[]): OperationalNotice[] =>
  set?.state === "ok" ? set.notices.filter((n) => citations.includes(n.ref)) : [];
