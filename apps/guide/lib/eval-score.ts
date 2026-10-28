/**
 * Punteggio automatico delle prove di qualità (ask:eval), logica pura.
 *
 * È un primo filtro, non un giudizio: segnala esiti inattesi, citazioni mancanti, fatti attribuiti a un
 * altro luogo, parole vietate dalla persona, formato non parlato e risposte troppo lunghe. Fedeltà,
 * gradi di certezza e voce restano da valutare a mano (docs/v0.4-gaia/RUBRICHE.md).
 */
import { POSITION_CITATION, type AskAnswer } from "./ask";
import { PERSONA_CITATION, PERSONA } from "./persona";

export interface EvalExpectation {
  /** Esito atteso senza ricerca web; una lista = ogni esito della lista va bene. */
  status?: string | string[];
  /** Affermazioni attese tra le citazioni (riferimento breve o completo; anche context:position e persona:gaia). */
  cite?: string[];
}

export interface EvalScore {
  /** null: non valutabile (la risposta viene dalla ricerca web, l'esito atteso vale senza ricerca). */
  statusOk: boolean | null;
  missingCites: string[];
  otherPlaceCitations: string[];
  bannedWords: string[];
  markdown: boolean;
  sentences: number;
  tooLong: boolean;
  /** Supera tutti i controlli automatici (resta da leggere). */
  pass: boolean;
}

/** Frasi massime prima di segnalare la lunghezza: un po' di margine sulla persona (4 e 10). */
export const SENTENCE_LIMITS = { auto: 6, deep: 12 } as const;

const MARKDOWN = /(^|\n)\s*([-*•]|\d+[.)])\s+\S|\*\*|__|(^|\n)#{1,6}\s/;

export const countSentences = (text: string) => text.split(/[.!?…]+(?:\s+|$)/).filter((s) => s.trim().length > 0).length;

export function scoreAnswer(
  expect: EvalExpectation,
  answer: AskAnswer,
  opts: { destination: string; locale: "it" | "en"; depth: "auto" | "deep" },
): EvalScore {
  const allowed = expect.status === undefined ? null : Array.isArray(expect.status) ? expect.status : [expect.status];
  const statusOk = allowed === null || answer.origin === "web" ? null : allowed.includes(answer.status);

  const full = (ref: string) => (ref.includes(":") ? ref : `${opts.destination}:${ref}`);
  const missingCites = (expect.cite ?? []).filter((ref) => {
    if (ref === POSITION_CITATION) return !answer.usedPosition;
    if (ref === PERSONA_CITATION) return !answer.usedPersona;
    return !answer.citations.includes(full(ref));
  });

  const text = answer.answer.toLocaleLowerCase(opts.locale);
  const bannedWords = PERSONA.bannedWords[opts.locale].filter((w) => new RegExp(`(^|[^\\p{L}])${w.toLocaleLowerCase(opts.locale)}([^\\p{L}]|$)`, "u").test(text));
  const markdown = MARKDOWN.test(answer.answer);
  const sentences = countSentences(answer.answer);
  const tooLong = sentences > SENTENCE_LIMITS[opts.depth];
  const otherPlaceCitations = answer.otherPlaceCitations ?? [];

  return {
    statusOk,
    missingCites,
    otherPlaceCitations,
    bannedWords,
    markdown,
    sentences,
    tooLong,
    pass: statusOk !== false && answer.status !== "rejected" && missingCites.length === 0 && bannedWords.length === 0 && !markdown && !tooLong,
  };
}

/** Riassunto di un punteggio per la tabella del rapporto. */
export function scoreNote(s: EvalScore): string {
  const notes = [
    s.statusOk === false ? "esito inatteso" : null,
    s.missingCites.length ? `mancano ${s.missingCites.join(", ")}` : null,
    s.otherPlaceCitations.length ? `altro luogo: ${s.otherPlaceCitations.map((r) => r.split(":").pop()).join(", ")}` : null,
    s.bannedWords.length ? `parole vietate: ${s.bannedWords.join(", ")}` : null,
    s.markdown ? "markdown" : null,
    s.tooLong ? `${s.sentences} frasi` : null,
  ].filter(Boolean);
  return notes.length ? notes.join("; ") : "—";
}
