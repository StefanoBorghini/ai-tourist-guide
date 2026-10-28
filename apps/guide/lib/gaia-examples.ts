/**
 * Esempi di riferimento di Gaia: per ogni domanda di prova, la risposta che vorremmo, scritta o
 * approvata dalla redazione. Servono a due cose:
 * - misurare un modello (quanto si avvicina alle risposte approvate);
 * - allenare un modello aperto (LoRA o fine-tuning) a rispondere come Gaia, senza dipendere da un fornitore.
 *
 * Logica pura: ogni esempio passa dagli stessi controlli della produzione (checkModelAnswer: citazioni
 * esistenti, numeri e secoli presi dalle fonti, 112 nelle emergenze) e dal punteggio automatico
 * (eval-score: esito atteso, citazioni attese, parole vietate, niente markdown, lunghezza). Un esempio
 * che non li supera non deve diventare materiale di allenamento: insegnerebbe a sbagliare.
 * Formato del file e procedura di approvazione: docs/v0.4-gaia/ESEMPI.md.
 */
import type { BundleContent } from "@guide/bundle/client";
import { z } from "zod";
import { ASK_STATUSES, POSITION_CITATION, SYSTEM_PROMPT, askRequestSchema, buildKnowledge, buildQuestionMessage, checkModelAnswer, type AskRequest } from "./ask";
import { scoreAnswer, scoreNote } from "./eval-score";
import { PERSONA_CITATION, PERSONA_PROMPT } from "./persona";

/** Una domanda di prova (file ASK-EVAL / GAIA-EVAL nel Territory Pack): i campi che descrivono la richiesta. */
export interface EvalCase {
  id: string;
  question: string;
  /** Luogo in cui si trova il visitatore. */
  place?: string;
  /** Luogo selezionato nell'app. */
  selected?: string;
  /** Posizione simulata: il visitatore è in questo luogo (coordinate dal bundle). */
  at?: string;
  depth?: "auto" | "deep";
  status?: string | string[];
  cite?: string[];
  history?: { question: string; answer: string }[];
  told?: string[];
}

/** Riferimento completo da uno breve ("slug" → "destinazione:slug"). */
export const fullRef = (destination: string, slug?: string) => (slug ? (slug.includes(":") ? slug : `${destination}:${slug}`) : undefined);

/** Citazioni dell'esempio con i riferimenti completi (posizione e persona restano come sono; un'emergenza non cita nulla). */
function exampleCitations(destination: string, ex: Example): string[] {
  if (ex.status === "safety") return [];
  return ex.citations.map((c) => (c === POSITION_CITATION || c === PERSONA_CITATION ? c : fullRef(destination, c)!));
}

/** La richiesta che l'app manderebbe per questa domanda di prova (stessa costruzione di ask:eval). */
export function evalRequest(content: BundleContent, locale: "it" | "en", q: EvalCase): AskRequest {
  const ref = (slug?: string) => fullRef(content.destination, slug);
  const at = ref(q.at);
  const location = at ? content.places.find((p) => p.ref === at)?.location : undefined;
  return askRequestSchema.parse({
    destination: content.destination,
    locale,
    question: q.question,
    currentPlace: ref(q.place) ?? at,
    selectedPlace: ref(q.selected),
    position: location ? { lon: location[0], lat: location[1], accuracyM: 8, simulated: true } : null,
    history: q.history ?? [],
    told: (q.told ?? []).map((t) => ref(t)!),
    depth: q.depth ?? "auto",
  });
}

export const exampleSchema = z.object({
  /** Stesso id della domanda di prova. */
  id: z.string().min(1),
  status: z.enum(ASK_STATUSES),
  answer: z.string().min(1),
  /** Riferimenti brevi o completi; anche "context:position" e "persona:gaia". */
  citations: z.array(z.string()),
  /** Solo la redazione lo mette a true, dopo aver letto la risposta. */
  approved: z.boolean(),
  /** Chi ha scritto o approvato, e quando (facoltativo). */
  by: z.string().optional(),
  note: z.string().optional(),
});
export type Example = z.infer<typeof exampleSchema>;

export const examplesFileSchema = z.object({
  suite: z.string(),
  version: z.string(),
  destination: z.string(),
  locale: z.enum(["it", "en"]),
  /** File delle domande di prova, relativo al file degli esempi. */
  questions: z.string(),
  examples: z.array(exampleSchema),
});
export type ExamplesFile = z.infer<typeof examplesFileSchema>;

export interface ExampleCheck {
  id: string;
  ok: boolean;
  problems: string[];
  /** Da rileggere, ma non bloccanti: per esempio una caratteristica attribuita apertamente a un altro luogo. */
  warnings: string[];
}

/**
 * Controlla un esempio con le regole della produzione e con le attese della domanda di prova.
 * Le citazioni dell'esempio possono essere brevi: si completano con la destinazione.
 */
export function checkExample(content: BundleContent, locale: "it" | "en", q: EvalCase, ex: Example): ExampleCheck {
  const req = evalRequest(content, locale, q);
  const raw = JSON.stringify({ status: ex.status, answer: ex.answer, citations: exampleCitations(content.destination, ex) });
  const problems: string[] = [];

  const checked = checkModelAnswer(raw, content, req);
  if (!checked.ok) return { id: ex.id, ok: false, problems: [`controllo della produzione: ${checked.reason}`], warnings: [] };
  if (ex.status === "safety" && ex.citations.length > 0) problems.push("un'emergenza non ha citazioni");

  const score = scoreAnswer({ status: q.status, cite: q.cite }, checked.answer, { destination: content.destination, locale, depth: req.depth });
  if (!score.pass) problems.push(`punteggio automatico: ${scoreNote(score)}`);
  // Un fatto di un altro luogo è lecito solo se la risposta lo attribuisce a quel luogo (regola 8): la
  // redazione lo verifica leggendo. Non si segnala per i luoghi vicini proposti a partire dalla posizione.
  const warnings =
    score.otherPlaceCitations.length > 0 && !checked.answer.usedPosition ? [`cita un altro luogo, controlla l'attribuzione: ${score.otherPlaceCitations.join(", ")}`] : [];

  return { id: ex.id, ok: problems.length === 0, problems, warnings };
}

/** Un esempio per l'allenamento, nel formato a messaggi accettato dagli strumenti di fine-tuning più diffusi. */
export interface TrainingRecord {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
}

/**
 * Lo stesso prompt della produzione (regole, persona, base, contesto e domanda) e, come risposta,
 * l'esempio nel formato JSON che la produzione si aspetta. Il modello allenato impara così a rispondere
 * in quel formato, e la sua risposta passa dagli stessi controlli.
 */
export function toTrainingRecord(content: BundleContent, locale: "it" | "en", q: EvalCase, ex: Example): TrainingRecord {
  const req = evalRequest(content, locale, q);
  const citations = exampleCitations(content.destination, ex);
  return {
    messages: [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n${PERSONA_PROMPT}\n\n${buildKnowledge(content)}` },
      { role: "user", content: buildQuestionMessage(content, req) },
      { role: "assistant", content: JSON.stringify({ status: ex.status, answer: ex.answer, citations }) },
    ],
  };
}
