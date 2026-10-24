/**
 * Scheda «Domande» dello Studio: le domande dei visitatori a cui la guida non ha saputo rispondere del tutto, raccolte
 * dal registro (migrazione 20261103000000, lib/question-gaps.ts). Tipi, etichette e filtri, senza rete.
 * Le domande non diventano mai contenuti da sole: la redazione decide se e come coprirle nel Territory Pack.
 */
export const GAP_KINDS = ["not_in_knowledge", "partial", "rejected", "web_answer", "web_unavailable", "ambiguous"] as const;
export type StudioGapKind = (typeof GAP_KINDS)[number];
export const GAP_REVIEW = ["new", "planned", "covered", "ignored"] as const;
export type StudioGapReview = (typeof GAP_REVIEW)[number];

export interface StudioQuestionGap {
  id: string;
  pack: string;
  locale: string;
  question: string;
  kind: StudioGapKind;
  place: string | null;
  selected: string | null;
  reason: string | null;
  webSources: { url: string; title: string }[];
  hits: number;
  firstSeen: string;
  lastSeen: string;
  expiresAt: string;
  status: StudioGapReview;
  reviewedAt: string | null;
}

export const GAP_KIND_LABELS: Record<StudioGapKind, string> = {
  not_in_knowledge: "Manca nella base",
  partial: "Risposta parziale",
  rejected: "Risposta scartata dai controlli",
  web_answer: "Completata con la ricerca online",
  web_unavailable: "Serviva la ricerca online",
  ambiguous: "Luogo non indicato",
};

export const GAP_REVIEW_LABELS: Record<StudioGapReview, string> = {
  new: "Da vedere",
  planned: "In programma",
  covered: "Coperta",
  ignored: "Ignorata",
};

export const isGapReview = (v: string | undefined): v is StudioGapReview => !!v && (GAP_REVIEW as readonly string[]).includes(v);

/** Data del database (AAAA-MM-GG) come la legge la redazione. */
export function formatDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : day;
}

/** Luogo come slug leggibile («pack:slug» → «slug»). */
export const placeLabel = (ref: string | null) => (ref ? (ref.split(":").pop() ?? ref) : null);
