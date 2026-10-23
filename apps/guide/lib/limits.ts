/**
 * Limiti d'uso e tetto di spesa delle domande, logica pura (testata).
 *
 * Valgono per singola istanza del server: con più istanze attive il tetto effettivo è il tetto per
 * istanza moltiplicato per il numero di istanze. Sono argini contro abusi e guasti, non una quota
 * globale: il limite di spesa affidabile resta quello del workspace nella console del fornitore.
 */

/** Finestra mobile per chiave (indirizzo): quante richieste negli ultimi `windowMs`. */
export class WindowLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    /** Chiavi tenute in memoria al massimo: oltre, si tolgono le scadute e poi le più vecchie. */
    private readonly maxKeys = 5000,
  ) {}

  /** Registra un uso e dice se il limite è superato. */
  hit(key: string, now = Date.now()): boolean {
    const recent = this.peek(key, now);
    recent.push(now);
    // Reinserita in coda: l'ordine della mappa è dalla chiave usata meno di recente.
    this.hits.delete(key);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.evict(now);
    return recent.length > this.max;
  }

  /** C'è ancora spazio, senza registrare l'uso? */
  allows(key: string, now = Date.now()): boolean {
    return this.peek(key, now).length < this.max;
  }

  get size(): number {
    return this.hits.size;
  }

  private peek(key: string, now: number): number[] {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
  }

  /**
   * Prima le chiavi senza usi recenti, poi le meno recenti. Mai svuotare tutto: chi riempie la mappa
   * con molti indirizzi non deve poter azzerare i limiti degli altri.
   */
  private evict(now: number): void {
    for (const [key, times] of this.hits) if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    for (const key of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(key);
    }
  }
}

/**
 * Tetto di spesa giornaliero (giorno UTC) per istanza, in dollari stimati.
 * Prima di una chiamata si chiede se c'è spazio per la sua riserva prudente; dopo si registra il
 * costo stimato, o la riserva se il costo non è stimabile (modello senza listino, errore a metà).
 */
export class SpendGuard {
  private day = "";
  private spent = 0;
  constructor(readonly dailyUsd: number) {}

  private roll(now: number) {
    const d = new Date(now).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.spent = 0;
    }
  }

  /** C'è spazio per una spesa prevista? (dailyUsd = 0: nessun tetto) */
  allows(reserveUsd: number, now = Date.now()): boolean {
    this.roll(now);
    return this.dailyUsd <= 0 || this.spent + reserveUsd <= this.dailyUsd;
  }

  record(usd: number, now = Date.now()): void {
    this.roll(now);
    if (Number.isFinite(usd) && usd > 0) this.spent += usd;
  }

  spentToday(now = Date.now()): number {
    this.roll(now);
    return Math.round(this.spent * 1e5) / 1e5;
  }
}

/** Tetto di spesa giornaliero per istanza in dollari (ASK_DAILY_BUDGET_USD, default 10; 0 = nessun tetto). */
export function dailyBudgetUsd(env: Record<string, string | undefined> = process.env): number {
  const raw = env.ASK_DAILY_BUDGET_USD?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 100_000) : 10;
}
