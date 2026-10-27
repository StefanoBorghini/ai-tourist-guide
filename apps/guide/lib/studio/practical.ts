/**
 * Informazioni pratiche dei luoghi nello Studio (migrazione 20261104000000): orari, accesso, biglietti, trasporti,
 * permessi, sicurezza. Logica pura, testata: lettura del modulo e nuovo elenco da salvare. Le regole vere stanno nel
 * database (studio_set_practical), uguali a quelle dello schema del Territory Pack; qui si danno solo messaggi chiari
 * prima del salvataggio.
 *
 * Gaia le usa come dati datati (docs/v0.4-gaia/CONDIZIONI.md): un'informazione vale fino a checkedAt +
 * recheckAfterDays; dopo, Gaia non la dice come attuale. «Aperto oggi» si può dire solo con un'informazione valida.
 */
import { addDays, isIsoDate } from "../local-events";

export const PRACTICAL_KIND_LABELS = {
  opening_hours: "Orari",
  access: "Accesso",
  tickets: "Biglietti",
  transport: "Trasporti",
  permission: "Permessi",
  safety: "Sicurezza",
} as const;
export type PracticalKindKey = keyof typeof PRACTICAL_KIND_LABELS;

/** Un'informazione pratica come la salva il database (formato del Territory Pack). */
export interface PracticalItem {
  id: string;
  kind: PracticalKindKey;
  text: Record<string, string>;
  checkedAt: string;
  recheckAfterDays: number;
  source?: string;
}

export const PRACTICAL_LIMITS = { textChars: 600, maxItems: 30, minDays: 1, maxDays: 730, defaultDays: 90 } as const;

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Ultimo giorno di validità (AAAA-MM-GG). */
export const validUntil = (item: Pick<PracticalItem, "checkedAt" | "recheckAfterDays">) => addDays(item.checkedAt, item.recheckAfterDays);

/** Scaduta alla data indicata (AAAA-MM-GG): Gaia non la dice più come attuale. */
export const isExpired = (item: Pick<PracticalItem, "checkedAt" | "recheckAfterDays">, today: string) => validUntil(item) < today;

/** Identificativo nuovo e unico nel luogo, dal tipo: «orari», «orari-2», … */
export function newPracticalId(kind: PracticalKindKey, existing: readonly PracticalItem[]): string {
  const base = kind.replace(/_/g, "-");
  const used = new Set(existing.map((i) => i.id));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

type Field = (name: string) => string;

/**
 * Un'informazione dal modulo (campi kind, text_it, text_en, checkedAt, recheckAfterDays, source), o il primo
 * problema in parole semplici. `today` è la data del territorio: la data del controllo non può essere nel futuro.
 */
export function parsePracticalForm(field: Field, id: string, today: string): { ok: true; item: PracticalItem } | { ok: false; error: string } {
  const kind = field("kind");
  if (!(kind in PRACTICAL_KIND_LABELS)) return { ok: false, error: "Scegli il tipo di informazione." };
  const text: Record<string, string> = {};
  for (const l of ["it", "en"]) {
    const t = field(`text_${l}`).replace(/\s+/g, " ").trim();
    if (t.length > PRACTICAL_LIMITS.textChars) return { ok: false, error: `Il testo (${l}) è troppo lungo: al massimo ${PRACTICAL_LIMITS.textChars} caratteri.` };
    if (t) text[l] = t;
  }
  if (!text.it) return { ok: false, error: "Scrivi il testo in italiano." };
  const checkedAt = field("checkedAt");
  if (!isIsoDate(checkedAt)) return { ok: false, error: "Indica la data in cui l'informazione è stata controllata." };
  if (checkedAt > today) return { ok: false, error: "La data del controllo non può essere nel futuro." };
  const daysRaw = field("recheckAfterDays");
  const days = daysRaw === "" ? PRACTICAL_LIMITS.defaultDays : Number(daysRaw);
  if (!Number.isInteger(days) || days < PRACTICAL_LIMITS.minDays || days > PRACTICAL_LIMITS.maxDays) {
    return { ok: false, error: `«Da ricontrollare dopo» va da ${PRACTICAL_LIMITS.minDays} a ${PRACTICAL_LIMITS.maxDays} giorni.` };
  }
  if (!SLUG_RE.test(id)) return { ok: false, error: "Identificativo non valido." };
  const source = field("source");
  return {
    ok: true,
    item: { id, kind: kind as PracticalKindKey, text, checkedAt, recheckAfterDays: days, ...(source ? { source } : {}) },
  };
}

/** Nuovo elenco dopo l'aggiunta, la modifica (stesso id, stessa posizione) o la rimozione di un'informazione. */
export function applyPracticalChange(
  current: readonly PracticalItem[],
  change: { op: "add"; item: PracticalItem } | { op: "update"; item: PracticalItem } | { op: "delete"; id: string },
): { ok: true; items: PracticalItem[] } | { ok: false; error: string } {
  if (change.op === "delete") {
    if (!current.some((i) => i.id === change.id)) return { ok: false, error: "Informazione non trovata: forse è già stata tolta." };
    return { ok: true, items: current.filter((i) => i.id !== change.id) };
  }
  if (change.op === "update") {
    if (!current.some((i) => i.id === change.item.id)) return { ok: false, error: "Informazione non trovata: forse è stata tolta nel frattempo." };
    return { ok: true, items: current.map((i) => (i.id === change.item.id ? change.item : i)) };
  }
  if (current.length >= PRACTICAL_LIMITS.maxItems) return { ok: false, error: `Al massimo ${PRACTICAL_LIMITS.maxItems} informazioni pratiche per luogo.` };
  if (current.some((i) => i.id === change.item.id)) return { ok: false, error: "Esiste già un'informazione con questo identificativo." };
  return { ok: true, items: [...current, change.item] };
}
