/**
 * Registro delle domande senza risposta: quali domande registrare e in che forma. Logica pura, senza rete.
 *
 * Una domanda si registra quando il sistema ha rilevato una lacuna dall'esito della risposta (non da parole chiave):
 * la base non conteneva l'informazione o la conteneva in parte, la risposta del modello non ha superato i controlli, la
 * ricerca online l'ha completata o non era possibile. Non si registrano le risposte complete, quelle fuori tema, le
 * emergenze, i servizi non disponibili e gli «Approfondisci» (la prima domanda è già stata contata).
 *
 * Si conserva il minimo: testo mascherato (redactForLog) e accorciato, lingua, luogo come riferimento del pack, tipo di
 * lacuna, versione della base. Niente risposta, cronologia, posizione, indirizzo IP o account. Il testo non è anonimo:
 * il mascheramento riconosce solo forme fisse. Vedi docs/v0.3-platform/DOMANDE-SENZA-RISPOSTA.md.
 */
import type { AskAnswer, AskRequest } from "./ask";
import { ambiguousWithoutPlace, redactForLog } from "./ask-web";

/** Caratteri conservati della domanda (anche il database rifiuta oltre). */
export const GAP_QUESTION_CHARS = 300;
const GAP_REASON_CHARS = 120;
const GAP_WEB_SOURCES = 5;

export type GapKind = "not_in_knowledge" | "partial" | "rejected" | "web_answer" | "web_unavailable" | "ambiguous";

/** Una riga da registrare: i parametri di gap_record() (migrazione 20261104000000). */
export interface GapRecord {
  pack: string;
  locale: string;
  /** Domanda mascherata e accorciata, come la vede la redazione. */
  question: string;
  /** Testo normalizzato: il database ne calcola l'impronta per raggruppare le domande uguali. */
  key: string;
  kind: GapKind;
  place: string | null;
  selected: string | null;
  reason: string | null;
  webSources: { url: string; title: string }[];
  kbHash: string;
  prompt: string;
}

/** Tipo di lacuna dall'esito della risposta, oppure null se la domanda non va registrata. */
export function gapKind(req: AskRequest, answer: AskAnswer, rejected?: string): GapKind | null {
  if (answer.status === "off_topic" || answer.status === "safety" || answer.status === "unavailable") return null;
  if (req.depth === "deep") return null;
  if (answer.origin === "web") return "web_answer";
  if (answer.status === "rejected" || rejected) return "rejected";
  if (answer.status !== "partial" && answer.status !== "not_in_knowledge") return null;
  if (ambiguousWithoutPlace(req)) return "ambiguous";
  if (answer.webUnavailable) return "web_unavailable";
  return answer.status;
}

/** Testo per raggruppare: minuscolo, solo lettere e cifre separate da uno spazio («Perché?» = «perché»). */
export function normalizeQuestion(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, GAP_QUESTION_CHARS).trim();
}

/**
 * La riga da registrare per questa domanda, oppure null. `isPlace` dice se un riferimento è un luogo della base
 * caricata: i luoghi arrivano dal dispositivo, e un testo qualsiasi al posto del riferimento non deve finire nel registro.
 */
export function gapRecord(
  req: AskRequest,
  input: { answer: AskAnswer; rejected?: string; kbHash: string; prompt: string; isPlace: (ref: string) => boolean },
): GapRecord | null {
  const kind = gapKind(req, input.answer, input.rejected);
  if (!kind) return null;
  const question = redactForLog(req.question).replace(/\s+/g, " ").trim().slice(0, GAP_QUESTION_CHARS).trim();
  const key = normalizeQuestion(question);
  if (question.length < 2 || !key) return null;
  const reason = input.rejected ?? (input.answer.status === "rejected" ? input.answer.checkReason : undefined);
  const place = (ref: string | null | undefined) => (ref && input.isPlace(ref) ? ref : null);
  return {
    pack: req.destination,
    locale: req.locale,
    question,
    key,
    kind,
    place: place(req.currentPlace),
    selected: place(req.selectedPlace),
    // Solo il tipo di controllo non superato: i dettagli dopo «:» riprendono testo della risposta del modello.
    reason: reason ? redactForLog(reason.split(":")[0]!).trim().slice(0, GAP_REASON_CHARS) || null : null,
    webSources: (input.answer.webSources ?? []).slice(0, GAP_WEB_SOURCES).map((s) => ({ url: s.url, title: s.title })),
    kbHash: input.kbHash,
    prompt: input.prompt,
  };
}
