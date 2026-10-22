/**
 * Statistiche delle prove `ask:eval` / `ask:compare`: logica pura, testata.
 * Su pochi campioni i percentili sono indicativi: `enough` lo dice esplicitamente.
 */

/** Campioni sotto i quali mediana e 90° percentile non bastano per conclusioni. */
export const MIN_SAMPLES = 10;

/** Percentile con il metodo del rango più vicino (un valore osservato, mai interpolato). */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

export interface Stats {
  n: number;
  p50: number | null;
  p90: number | null;
  max: number | null;
  /** Abbastanza campioni per leggere mediana e 90° percentile? */
  enough: boolean;
}

export function stats(values: number[]): Stats {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    max: values.length ? Math.max(...values) : null,
    enough: values.length >= MIN_SAMPLES,
  };
}

/** Riga leggibile: «n 12 · mediana 0.0210 · p90 0.0480 · max 0.0610» (con avviso se i campioni sono pochi). */
export function formatStats(s: Stats, digits = 4, unit = ""): string {
  if (s.n === 0) return "nessun campione";
  const f = (v: number | null) => (v === null ? "—" : `${v.toFixed(digits)}${unit}`);
  return `n ${s.n} · mediana ${f(s.p50)} · p90 ${f(s.p90)} · max ${f(s.max)}${s.enough ? "" : ` (meno di ${MIN_SAMPLES} campioni: indicativo)`}`;
}

// ------------------------------------------------------------------ valutazione alla cieca

/**
 * Rubrica di qualità, la stessa per entrambe le configurazioni (vedi docs/v0.3-platform/COSTI-AI.md).
 * Ogni voce 0–2; `fuorviante` vero se la risposta afferma ciò che le fonti non dicono o presenta
 * ipotesi come certezze. Lunghezza e numero di fonti non sono criteri.
 */
export const RUBRIC = {
  corretta: "0 errata · 1 in parte corretta · 2 corretta (rispetto alle fonti citate e alla base)",
  completezza: "0 manca l'essenziale · 1 risponde in parte · 2 risponde alla domanda",
  pertinenza: "0 fuori tema · 1 divaga · 2 pertinente",
  fonti: "0 nessuna fonte adeguata · 1 fonti deboli o citazioni imprecise · 2 fonti attendibili citate correttamente",
  fuorviante: "true se afferma qualcosa di non supportato o presenta ipotesi come certezze",
} as const;

export interface Score {
  corretta: number | null;
  completezza: number | null;
  pertinenza: number | null;
  fonti: number | null;
  fuorviante: boolean | null;
  note?: string;
}
export const emptyScore = (): Score => ({ corretta: null, completezza: null, pertinenza: null, fonti: null, fuorviante: null, note: "" });

/** Per ogni domanda, quale esecuzione ("a" o "b") sta dietro le etichette X e Y. */
export type BlindKey = Record<string, { X: "a" | "b"; Y: "a" | "b" }>;

/** Assegna X/Y a caso per ogni domanda (`random` iniettabile per i test). */
export function blindKey(ids: string[], random: () => number = Math.random): BlindKey {
  return Object.fromEntries(ids.map((id) => [id, random() < 0.5 ? { X: "a" as const, Y: "b" as const } : { X: "b" as const, Y: "a" as const }]));
}

export interface ScoreAggregate {
  valutate: number;
  /** Quota di risposte con corretta = 2. */
  corrette: number | null;
  medie: { corretta: number | null; completezza: number | null; pertinenza: number | null; fonti: number | null };
  fuorvianti: number;
}

/** Riporta i punteggi X/Y alle esecuzioni a/b con la chiave e li riassume per esecuzione. */
export function aggregateScores(key: BlindKey, scores: Record<string, { X: Score; Y: Score }>): { a: ScoreAggregate; b: ScoreAggregate } {
  const per: { a: Score[]; b: Score[] } = { a: [], b: [] };
  for (const [id, s] of Object.entries(scores)) {
    const k = key[id];
    if (!k) continue;
    per[k.X].push(s.X);
    per[k.Y].push(s.Y);
  }
  const agg = (list: Score[]): ScoreAggregate => {
    const rated = list.filter((s) => s.corretta !== null);
    const mean = (f: keyof ScoreAggregate["medie"]) => {
      const v = list.map((s) => s[f]).filter((x): x is number => typeof x === "number");
      return v.length ? Math.round((v.reduce((t, x) => t + x, 0) / v.length) * 100) / 100 : null;
    };
    return {
      valutate: rated.length,
      corrette: rated.length ? Math.round((rated.filter((s) => s.corretta === 2).length / rated.length) * 100) / 100 : null,
      medie: { corretta: mean("corretta"), completezza: mean("completezza"), pertinenza: mean("pertinenza"), fonti: mean("fonti") },
      fuorvianti: list.filter((s) => s.fuorviante === true).length,
    };
  };
  return { a: agg(per.a), b: agg(per.b) };
}
