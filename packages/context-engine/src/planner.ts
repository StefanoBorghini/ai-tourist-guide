import { toblerEstimator, type Point, type WalkEstimator } from "./walking.ts";

/**
 * Pianificatore dei tour dinamici ("ho 40 minuti", "devo tornare al battello alle 17:30").
 *
 * È un orienteering problem: scegliere e ordinare le tappe che massimizzano il
 * valore complessivo entro il tempo disponibile, includendo il cammino e la sosta
 * in ogni tappa e, se c'è un'ancora, il ritorno all'ancora con il suo margine.
 *
 * Algoritmo:
 * - soluzione esatta con programmazione dinamica sui sottoinsiemi per i
 *   EXACT_LIMIT candidati di maggior valore (2^12 × 12² ≈ 600k passi);
 * - inserimento greedy per rapporto valore / tempo aggiunto su tutti i candidati,
 *   con miglioramento 2-opt dell'ordine;
 * - si tiene il piano di valore maggiore (a parità, il più breve).
 * Il solo greedy è miope: con poco tempo sceglie tappe rapide e poco importanti
 * e poi non ha più spazio per quella che conta. Gira sul dispositivo in pochi ms.
 *
 * Il pianificatore non conosce l'AI: restituisce numeri, l'AI li racconta.
 */

export interface Candidate extends Point {
  id: string;
  importance: number;
  dwellMin: number;
  tags?: readonly string[];
  stepFree?: boolean | undefined;
  stairs?: number | undefined;
  /** false se non si raggiunge a piedi (es. un'isola): mai proposto come tappa. */
  walkable?: boolean | undefined;
}

export interface AnchorTarget extends Point {
  id: string;
  /** Ora entro cui essere all'ancora (ms dall'epoca). */
  deadline: number;
  safetyMarginMin: number;
}

export interface PlanRequest {
  now: number;
  start: Point;
  candidates: readonly Candidate[];
  /** Tempo che il visitatore vuole dedicare. Facoltativo se c'è un'ancora. */
  budgetMin?: number;
  anchor?: AnchorTarget;
  visited?: ReadonlySet<string>;
  interests?: readonly string[];
  avoidStairs?: boolean;
  estimator?: WalkEstimator;
  /**
   * Percorso curato: i candidati sono le tappe nell'ordine dato. L'ordine non cambia e nessuna
   * tappa viene tolta; se il tempo non basta, slackS è negativo.
   */
  fixedOrder?: boolean;
}

export interface PlannedStop {
  placeId: string;
  walkS: number;
  arriveAt: number;
  leaveAt: number;
}

export type PlanStatus = "ok" | "no_time" | "no_candidates";

export interface TourPlan {
  status: PlanStatus;
  stops: PlannedStop[];
  /** Limite di tempo considerato: fine del budget o scadenza dell'ancora meno il margine. */
  availableUntil: number;
  /** Fine dell'ultima tappa o, se c'è un'ancora, arrivo all'ancora. */
  endAt: number;
  /** Cammino dall'ultima tappa all'ancora, in secondi. */
  returnWalkS: number | null;
  /** Tempo libero rimasto nel piano, in secondi. */
  slackS: number;
  value: number;
}

const INTEREST_BONUS = 1.5;
/** Numero massimo di candidati per la ricerca esatta. */
export const EXACT_LIMIT = 12;

export function candidateValue(c: Candidate, interests: readonly string[] = []): number {
  const matches = interests.length > 0 && (c.tags ?? []).some((t) => interests.includes(t));
  return c.importance ** 2 * (matches ? INTEREST_BONUS : 1);
}

export function planTour(request: PlanRequest): TourPlan {
  const { now, start, anchor } = request;
  const estimator = request.estimator ?? toblerEstimator();
  const budgetEnd = request.budgetMin !== undefined ? now + request.budgetMin * 60_000 : Infinity;
  const anchorEnd = anchor ? anchor.deadline - anchor.safetyMarginMin * 60_000 : Infinity;
  const availableUntil = Math.min(budgetEnd, anchorEnd);
  if (!Number.isFinite(availableUntil)) {
    throw new Error("planTour richiede un budget di tempo o un'ancora con scadenza");
  }

  const visited = request.visited ?? new Set<string>();
  const eligible = request.candidates
    .filter((c) => !visited.has(c.id))
    // In un percorso curato le tappe le ha scelte la redazione (es. il giro di un'isola).
    .filter((c) => request.fixedOrder || c.walkable !== false)
    .filter((c) => !request.avoidStairs || (c.stepFree !== false && !(c.stairs && c.stairs > 0)));
  const pool = eligible.slice().sort((a, b) => a.id.localeCompare(b.id));

  const walkCache = new Map<string, number>();
  const walk = (a: Point & { id?: string }, b: Point & { id?: string }, keyA: string, keyB: string) => {
    const key = `${keyA}→${keyB}`;
    let s = walkCache.get(key);
    if (s === undefined) {
      s = estimator.seconds(a, b);
      walkCache.set(key, s);
    }
    return s;
  };

  /** Simula la sequenza: restituisce la fine (arrivo all'ancora se presente) e le tappe. */
  const simulate = (seq: readonly Candidate[]) => {
    let t = now;
    let prev: Point = start;
    let prevKey = "@start";
    const stops: PlannedStop[] = [];
    for (const c of seq) {
      const w = walk(prev, c, prevKey, c.id);
      t += w * 1000;
      const arriveAt = t;
      t += c.dwellMin * 60_000;
      stops.push({ placeId: c.id, walkS: w, arriveAt, leaveAt: t });
      prev = c;
      prevKey = c.id;
    }
    let returnWalkS: number | null = null;
    if (anchor) {
      returnWalkS = walk(prev, anchor, prevKey, "@anchor");
      t += returnWalkS * 1000;
    }
    return { end: t, stops, returnWalkS };
  };

  const empty = simulate([]);
  if (empty.end > availableUntil) {
    return { status: "no_time", stops: [], availableUntil, endAt: empty.end, returnWalkS: empty.returnWalkS, slackS: (availableUntil - empty.end) / 1000, value: 0 };
  }

  const values = new Map(pool.map((c) => [c.id, candidateValue(c, request.interests)]));

  if (request.fixedOrder) {
    // Percorso curato: tutte le tappe, nell'ordine dato. Nessuna viene saltata in automatico:
    // se il tempo non basta lo dice slackS (negativo), e decide il visitatore.
    const result = simulate(eligible);
    return {
      status: eligible.length > 0 ? "ok" : "no_candidates",
      stops: result.stops,
      availableUntil,
      endAt: result.end,
      returnWalkS: result.returnWalkS,
      slackS: (availableUntil - result.end) / 1000,
      value: eligible.reduce((sum, c) => sum + values.get(c.id)!, 0),
    };
  }

  let sequence: Candidate[] = [];
  let currentEnd = empty.end;

  const insertGreedy = () => {
    for (;;) {
      let best: { seq: Candidate[]; end: number; ratio: number; value: number } | null = null;
      for (const c of pool) {
        if (sequence.includes(c)) continue;
        const value = values.get(c.id)!;
        for (let pos = 0; pos <= sequence.length; pos++) {
          const seq = [...sequence.slice(0, pos), c, ...sequence.slice(pos)];
          const { end } = simulate(seq);
          if (end > availableUntil) continue;
          const ratio = value / Math.max(end - currentEnd, 1000);
          if (!best || ratio > best.ratio || (ratio === best.ratio && value > best.value)) {
            best = { seq, end, ratio, value };
          }
        }
      }
      if (!best) return;
      sequence = best.seq;
      currentEnd = best.end;
    }
  };

  const improveOrder = () => {
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < sequence.length - 1; i++) {
        for (let j = i + 1; j < sequence.length; j++) {
          const seq = [...sequence.slice(0, i), ...sequence.slice(i, j + 1).reverse(), ...sequence.slice(j + 1)];
          const { end } = simulate(seq);
          if (end < currentEnd - 1) {
            sequence = seq;
            currentEnd = end;
            improved = true;
          }
        }
      }
    }
  };

  for (let round = 0; round < 3; round++) {
    const before = sequence.length;
    insertGreedy();
    improveOrder();
    if (sequence.length === before && round > 0) break;
  }

  // Ricerca esatta sui candidati di maggior valore.
  const exactPool = [...pool]
    .sort((a, b) => values.get(b.id)! - values.get(a.id)! || a.id.localeCompare(b.id))
    .slice(0, EXACT_LIMIT);
  const exact = exactSearch(exactPool, (seq) => simulate(seq).end, (c) => values.get(c.id)!, availableUntil);
  const sumValue = (seq: readonly Candidate[]) => seq.reduce((sum, c) => sum + values.get(c.id)!, 0);
  if (
    sumValue(exact) > sumValue(sequence) ||
    (sumValue(exact) === sumValue(sequence) && simulate(exact).end < currentEnd)
  ) {
    sequence = exact;
  }

  // A parità (quasi) di durata, si preferisce il verso che parte dalla tappa più vicina:
  // si entra dalla porta del borgo, non dal fondo. Il percorso al contrario ha lo stesso valore.
  if (sequence.length > 1) {
    const reversed = [...sequence].reverse();
    const reversedEnd = simulate(reversed).end;
    const firstWalk = (seq: readonly Candidate[]) => walk(start, seq[0]!, "@start", seq[0]!.id);
    if (reversedEnd <= simulate(sequence).end + 30_000 && firstWalk(reversed) < firstWalk(sequence)) {
      sequence = reversed;
    }
  }

  const result = simulate(sequence);
  return {
    status: sequence.length > 0 ? "ok" : "no_candidates",
    stops: result.stops,
    availableUntil,
    endAt: result.end,
    returnWalkS: result.returnWalkS,
    slackS: (availableUntil - result.end) / 1000,
    value: sequence.reduce((sum, c) => sum + values.get(c.id)!, 0),
  };
}

/**
 * Programmazione dinamica sui sottoinsiemi (Held-Karp con vincolo di tempo).
 * best[mask][last] = fine più precoce visitando esattamente `mask`, terminando in `last`.
 * La fine di una sequenza è calcolata da `endOf`, che include il ritorno all'ancora.
 */
function exactSearch(
  pool: readonly Candidate[],
  endOf: (seq: readonly Candidate[]) => number,
  valueOf: (c: Candidate) => number,
  availableUntil: number,
): Candidate[] {
  const n = pool.length;
  if (n === 0) return [];
  const size = 1 << n;
  // Fine del piano (ritorno all'ancora incluso) per ogni coppia (mask, last), e predecessore.
  const leaveAt = new Float64Array(size * n).fill(Infinity);
  const prev = new Int8Array(size * n).fill(-1);
  // Costi base: si ricavano da endOf su sequenze di 1 e 2 elementi, così da usare
  // esattamente lo stesso modello di cammino e sosta della simulazione.
  //
  // endOf([i, j]) - endOf([i]) = cammino(i→j) + sosta(j) + ritorno(j) - ritorno(i)
  // Sommando questi delta lungo una sequenza i ritorni intermedi si annullano:
  // fine(sequenza) = endOf([prima]) + Σ delta. Così la ricerca usa esattamente
  // lo stesso modello di cammino, sosta e ritorno della simulazione.
  const single = pool.map((c) => endOf([c]));
  const pairDelta = (i: number, j: number) => endOf([pool[i]!, pool[j]!]) - single[i]!;
  for (let i = 0; i < n; i++) {
    const mask = 1 << i;
    leaveAt[mask * n + i] = single[i]!;
  }
  const delta = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) delta[i * n + j] = pairDelta(i, j);

  for (let mask = 1; mask < size; mask++) {
    for (let last = 0; last < n; last++) {
      if (!(mask & (1 << last))) continue;
      const cur = leaveAt[mask * n + last]!;
      if (cur === Infinity) continue;
      for (let next = 0; next < n; next++) {
        if (mask & (1 << next)) continue;
        const nm = mask | (1 << next);
        const t = cur + delta[last * n + next]!;
        if (t < leaveAt[nm * n + next]!) {
          leaveAt[nm * n + next] = t;
          prev[nm * n + next] = last;
        }
      }
    }
  }

  let bestMask = 0;
  let bestLast = -1;
  let bestValue = 0;
  let bestEnd = Infinity;
  for (let mask = 1; mask < size; mask++) {
    let value = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) value += valueOf(pool[i]!);
    if (value < bestValue) continue;
    for (let last = 0; last < n; last++) {
      const end = leaveAt[mask * n + last]!;
      if (end > availableUntil) continue;
      if (value > bestValue || end < bestEnd) {
        bestValue = value;
        bestEnd = end;
        bestMask = mask;
        bestLast = last;
      }
    }
  }
  if (bestLast < 0) return [];

  const order: Candidate[] = [];
  let mask = bestMask;
  let last = bestLast;
  while (last >= 0) {
    order.unshift(pool[last]!);
    const p = prev[mask * n + last]!;
    mask &= ~(1 << last);
    last = p;
  }
  return order;
}
