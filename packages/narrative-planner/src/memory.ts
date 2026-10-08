/**
 * Memoria del tour: ciò che serve per un racconto progressivo, senza ripetizioni.
 * Vive sul dispositivo; il server la riceve solo come istantanea quando serve l'AI.
 * È immutabile: ogni aggiornamento restituisce una nuova memoria.
 */

export interface TourMemory {
  /** Luoghi visitati, nell'ordine. */
  visitedPlaces: string[];
  /** Unità già ascoltate (riferimenti completi). */
  heardUnits: string[];
  /** Affermazioni già raccontate, anche tramite risposte dell'AI. */
  toldAssertions: string[];
  /** Concetti introdotti e luogo in cui è successo. */
  introducedConcepts: Record<string, { atPlace: string | null }>;
  /** Promesse fatte ("ne riparleremo alla torre"): luogo di destinazione → luogo in cui è stata fatta. */
  openThreads: { target: string; fromPlace: string | null; text: string }[];
  /** Interesse per tema o tipo di unità, 0–1. */
  interests: Record<string, number>;
}

export function emptyMemory(): TourMemory {
  return { visitedPlaces: [], heardUnits: [], toldAssertions: [], introducedConcepts: {}, openThreads: [], interests: {} };
}

/** Registra affermazioni raccontate fuori dalle unità (es. in una risposta dell'AI). */
export function rememberAssertions(memory: TourMemory, assertionRefs: readonly string[]): TourMemory {
  return { ...memory, toldAssertions: [...new Set([...memory.toldAssertions, ...assertionRefs])] };
}

/**
 * Aggiorna l'interesse per un tema: sale quando il visitatore ascolta fino in fondo
 * o chiede di più, scende quando salta. Valori limitati tra 0 e 1, partenza da 0.5.
 */
export function adjustInterest(memory: TourMemory, key: string, signal: "more" | "completed" | "skipped"): TourMemory {
  const current = memory.interests[key] ?? 0.5;
  const delta = signal === "more" ? 0.15 : signal === "completed" ? 0.05 : -0.1;
  const next = Math.min(1, Math.max(0, current + delta));
  return { ...memory, interests: { ...memory.interests, [key]: Math.round(next * 100) / 100 } };
}
