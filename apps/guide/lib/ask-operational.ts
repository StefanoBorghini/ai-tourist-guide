/**
 * Contesto pratico delle domande a Gaia (fase F1, «contesto e prudenza»): data e ora sul posto, percorsi, informazioni
 * pratiche datate e note di sicurezza della destinazione. Logica pura, testata, senza rete né AI.
 *
 * Il sistema calcola, l'AI racconta: la data di oggi, le scadenze delle informazioni pratiche e quali dati si possono
 * citare li decide questo modulo; il modello li riferisce soltanto, citandoli come le affermazioni.
 *
 * Regola del proprietario: il bel tempo non dimostra che un sentiero sia aperto. Lo stato di oggi (aperto, chiuso,
 * praticabile, orari di oggi) si dice solo con un'informazione pratica ancora valida; altrimenti la risposta dichiara
 * l'incertezza e indica dove controllare. `claimsOperationalStatus` è il controllo deterministico della regola.
 *
 * Solo dati del bundle pubblico (decisione D10): nessun contenuto a pagamento arriva al modello per questa via.
 */
import type { BundleContent } from "@guide/bundle/client";
import { addDays, isValidTimeZone, localDate, localTime } from "./local-events";

/**
 * Fuso orario delle domande. Il bundle non porta ancora il fuso della destinazione (`destinations.timezone`, solo nel
 * database): si usa lo stesso valore predefinito della colonna (migrazione 20261031000000).
 */
export const DEFAULT_TIME_ZONE = "Europe/Rome";

/** Citazione della data e dell'ora calcolate dal sistema (non è un'affermazione della base). */
export const TIME_CITATION = "context:time";

/** Istante della domanda e fuso in cui leggerlo. */
export interface AskClock {
  now: number;
  timeZone: string;
}

export const askClock = (now: number = Date.now(), timeZone: string = DEFAULT_TIME_ZONE): AskClock => ({
  now,
  timeZone: isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE,
});

const WEEKDAYS = {
  it: ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"],
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
} as const;
const MONTHS = {
  it: ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
} as const;

export interface LocalNow {
  /** AAAA-MM-GG nel fuso indicato. */
  date: string;
  /** HH:MM nel fuso indicato. */
  time: string;
  /** «martedì 27 ottobre 2026, ore 14:35». */
  text: string;
  /** Numeri che una risposta può ripetere citando TIME_CITATION (giorno, mese, anno, ore, minuti). */
  numbers: string[];
}

export function localNow(clock: AskClock, locale: "it" | "en"): LocalNow {
  const date = localDate(clock.now, clock.timeZone);
  const time = localTime(clock.now, clock.timeZone);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":") as [string, string];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const text =
    locale === "it"
      ? `${WEEKDAYS.it[weekday]} ${d} ${MONTHS.it[m - 1]} ${y}, ore ${time}`
      : `${WEEKDAYS.en[weekday]} ${d} ${MONTHS.en[m - 1]} ${y}, ${time}`;
  const numbers = [String(d), String(m), String(y), hh, mm, String(Number(hh)), String(Number(mm)), `${hh}.${mm}`, `${Number(hh)}.${mm}`];
  return { date, time, text, numbers: [...new Set(numbers)] };
}

/**
 * Fascia oraria per la cache delle risposte: data e ora sul posto («2026-10-27T14»). Una risposta sugli orari di oggi o
 * sulle informazioni ancora valide non si serve più dalla cache quando cambiano l'ora o il giorno.
 */
export const cacheSlot = (clock: AskClock): string => `${localDate(clock.now, clock.timeZone)}T${localTime(clock.now, clock.timeZone).slice(0, 2)}`;

// ------------------------------------------------------------------ dati pratici citabili

export type OperationalKind = "info" | "route" | "safety";

/** Un dato pratico della base, con il riferimento con cui il modello lo cita. */
export interface OperationalItem {
  /** `info:<luogo>#<n>`, `route:<percorso>`, `safety:<id>`. */
  ref: string;
  kind: OperationalKind;
  /** Riga della base di conoscenza (senza il riferimento). */
  line: string;
  /** Testo da cui si prendono i numeri ammessi nella risposta. */
  numbers: string[];
  /** Fonti del dato (riferimenti del bundle). */
  sources: string[];
  /** Solo per le informazioni pratiche: data del controllo e ultimo giorno di validità (AAAA-MM-GG). */
  checkedAt?: string;
  validUntil?: string;
}

const NUMBER = /\d+(?:[.,]\d+)?/g;
const numbersOf = (text: string) => [...text.matchAll(NUMBER)].map((m) => m[0].replace(",", "."));

/** Anno, mese e giorno di una data AAAA-MM-GG, anche senza lo zero iniziale («1 ottobre»). */
const dateNumbers = (date: string) => date.split("-").flatMap((part) => [part, String(Number(part))]);

const PRACTICAL_LABEL: Record<string, string> = {
  opening_hours: "orari",
  access: "accesso",
  tickets: "biglietti",
  transport: "trasporti",
  permission: "permessi",
  safety: "sicurezza",
};
const DIFFICULTY_LABEL: Record<string, string> = { easy: "facile", medium: "media", hard: "impegnativa" };

/** Ore equivalenti a una durata in minuti, se tonde o mezze (90 → 1.5): chi risponde può dire «un'ora e mezza» o «1,5 ore». */
const hoursOf = (min: number) => (min % 30 === 0 ? [String(min / 60)] : []);

/**
 * Dati pratici del bundle, in ordine stabile (stesso bundle → stesso elenco, quindi la cache del prompt resta valida).
 * La validità delle informazioni pratiche è una data fissa (`checkedAt` + `recheckAfterDays`): se è passata lo dice il
 * messaggio della domanda, calcolato ogni volta (`expiredItems`), non la base.
 */
export function operationalItems(content: BundleContent): OperationalItem[] {
  const sourceTitle = new Map(content.sources.map((s) => [s.ref, s.title]));
  const titles = (refs: readonly string[]) => refs.map((r) => sourceTitle.get(r)).filter((t): t is string => t !== undefined).join("; ");
  const placeName = new Map(content.places.map((p) => [p.ref, p.name]));
  const items: OperationalItem[] = [];

  for (const r of [...content.routes].sort((a, b) => a.ref.localeCompare(b.ref))) {
    const stops = r.stops.map((s) => placeName.get(s.place) ?? s.place).join(" → ");
    const src = titles(r.sources);
    const parts = [
      r.name,
      `durata circa ${r.durationMin} min${r.calibration === "field_calibrated" ? " (misurata sul campo)" : " (stimata, non ancora misurata sul campo)"}`,
      ...(r.difficulty ? [`difficoltà ${DIFFICULTY_LABEL[r.difficulty] ?? r.difficulty}`] : []),
      ...(r.elevationGainM !== undefined ? [`dislivello ${r.elevationGainM} m`] : []),
      ...(stops ? [`tappe: ${stops}`] : []),
      ...(src ? [`fonti: ${src}`] : []),
    ];
    items.push({
      ref: `route:${r.ref}`,
      kind: "route",
      line: parts.join(" | "),
      numbers: [
        String(r.durationMin),
        ...hoursOf(r.durationMin),
        ...(r.elevationGainM !== undefined ? [String(r.elevationGainM)] : []),
        ...numbersOf(r.name),
      ],
      sources: [...r.sources],
    });
  }

  for (const p of [...content.places].sort((a, b) => a.ref.localeCompare(b.ref))) {
    p.practical.forEach((info, i) => {
      const validUntil = addDays(info.checkedAt, info.recheckAfterDays);
      const src = info.source ? titles([info.source]) : "";
      items.push({
        ref: `info:${p.ref}#${i + 1}`,
        kind: "info",
        line: [
          p.name,
          PRACTICAL_LABEL[info.kind] ?? info.kind,
          info.text,
          `controllata il ${info.checkedAt}, valida fino al ${validUntil}`,
          ...(src ? [`fonte: ${src}`] : ["fonte: non indicata"]),
        ].join(" | "),
        numbers: [...numbersOf(info.text), ...dateNumbers(info.checkedAt), ...dateNumbers(validUntil)],
        sources: info.source ? [info.source] : [],
        checkedAt: info.checkedAt,
        validUntil,
      });
    });
  }

  for (const n of content.safetyNotes) {
    items.push({ ref: `safety:${n.id}`, kind: "safety", line: n.text, numbers: numbersOf(n.text), sources: [] });
  }
  return items;
}

/** Informazioni pratiche non più valide alla data indicata (AAAA-MM-GG nel fuso della destinazione). */
export function expiredItems(items: readonly OperationalItem[], today: string): OperationalItem[] {
  return items.filter((i) => i.validUntil !== undefined && i.validUntil < today);
}

/** Sezioni della base di conoscenza con i dati pratici; vuoto se la destinazione non ne ha. */
export function operationalKnowledge(items: readonly OperationalItem[]): string[] {
  const lines: string[] = [];
  const section = (kind: OperationalKind, title: string) => {
    const list = items.filter((i) => i.kind === kind);
    if (list.length === 0) return;
    lines.push("", title);
    for (const i of list) lines.push(`- ${i.ref} | ${i.line}`);
  };
  section("route", "PERCORSI (dati della redazione: durata, difficoltà e tappe; non dicono se oggi il percorso è aperto)");
  section("info", "INFORMAZIONI PRATICHE (datate: valgono solo fino alla data indicata; dopo vanno ricontrollate alla fonte)");
  section("safety", "NOTE DI SICUREZZA DELLA DESTINAZIONE");
  return lines;
}

// ------------------------------------------------------------------ stato di oggi

/**
 * Frasi che dichiarano lo stato operativo di un luogo, un sentiero o un servizio («è aperto», «oggi sono chiusi»,
 * «risulta percorribile», «is open»). Non contano:
 * - le frasi ipotetiche, con «se», «if» o «whether» fino a quattro parole prima («non so se oggi il sentiero è aperto»);
 * - le descrizioni del paesaggio, con «aperto»/«chiuso» seguiti da «su», «verso», «tra», «da»… («è aperto sul golfo»,
 *   «è chiusa tra due promontori»).
 * È volutamente stretto: riconosce le affermazioni dirette, il resto lo valuta la suite di prova.
 */
// Confini di parola anche per le lettere accentate («è»): \b in JavaScript conosce solo l'ASCII.
const W0 = String.raw`(?<![\p{L}\p{N}])`;
const W1 = String.raw`(?![\p{L}\p{N}])`;
const IT_STATUS = new RegExp(
  String.raw`(?<!${W0}(?:se|qualora)\s(?:\S+\s){0,4})` +
    String.raw`${W0}(?:è|sono|sia|siano|risulta|risultano|resta|restano|rimane|rimangono)\s+(?:(?:oggi|ora|adesso|ancora|già)\s+)?` +
    String.raw`(?:apert[oaie]|chius[oaie]|percorribil[ei]|praticabil[ei]|agibil[ei]|transitabil[ei]|interdett[oaie])${W1}` +
    String.raw`(?!\s+(?:su|sul|sullo|sulla|sui|sugli|sulle|verso|tra|fra|da|dal|dallo|dalla|dai|dagli|dalle|in\s+(?:basso|alto)|a\s+(?:nord|sud|est|ovest))${W1}|\s+(?:sull|dall)['’])`,
  "iu",
);
const EN_STATUS = new RegExp(
  String.raw`(?<!${W0}(?:if|whether)\s(?:\S+\s){0,4})` +
    String.raw`${W0}(?:is|are|remains?|stays?)\s+(?:(?:currently|now|still|today|already)\s+)?(?:open|closed|passable|shut)${W1}` +
    String.raw`(?!\s+(?:onto|on|towards?|over|by|between|from|to\s+the\s+(?:sea|bay|gulf|view|north|south|east|west))${W1})`,
  "iu",
);

export function claimsOperationalStatus(answer: string): boolean {
  return IT_STATUS.test(answer) || EN_STATUS.test(answer);
}
