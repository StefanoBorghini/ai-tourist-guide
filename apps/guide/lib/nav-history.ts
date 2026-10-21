/**
 * Cronologia del browser per la guida (una sola pagina): il «back» del telefono torna indietro di un livello invece di
 * uscire dall'app, l'indirizzo dice cosa si sta guardando, e ricaricando si ritrova la stessa vista.
 *
 * Tre livelli, come in un'app nativa: 0 la Home; 1 una scheda (elenco delle Destinazioni, Percorsi, Profilo);
 * 2 la visita in corso. Si scende di un livello alla volta con il back; i cambi allo stesso livello sostituiscono la
 * voce invece di aggiungerne (niente cronologie lunghe né cicli). Nell'indirizzo solo `v` (scheda) e `d` (destinazione).
 * Logica pura, testata; GuideApp la applica con history.pushState/replaceState/go.
 */

export type NavTab = "home" | "esplora" | "percorsi" | "profilo";
export interface NavState {
  depth: 0 | 1 | 2;
  tab: NavTab;
  /** Destinazione della visita (livello 2) o della scheda Percorsi; null altrove. */
  d: string | null;
}

const TABS: readonly NavTab[] = ["home", "esplora", "percorsi", "profilo"];
/** Identificativo di destinazione accettato nell'indirizzo (come quelli dei pack: minuscole, cifre, punti, trattini). */
const DEST_RE = /^[a-z0-9][a-z0-9.-]{0,120}$/;

export const HOME: NavState = { depth: 0, tab: "home", d: null };

/** Stato della cronologia che corrisponde a ciò che l'app mostra. */
export function navStateOf(ui: { tab: NavTab; inVisit: boolean; destination: string | null }): NavState {
  if (ui.tab === "home") return HOME;
  if (ui.inVisit && ui.destination) return { depth: 2, tab: ui.tab, d: ui.destination };
  return { depth: 1, tab: ui.tab, d: ui.tab === "percorsi" ? ui.destination : null };
}

export const sameNav = (a: NavState | null, b: NavState | null) => !!a && !!b && a.depth === b.depth && a.tab === b.tab && a.d === b.d;

/** Valida lo stato letto da history.state (può venire da un'altra versione dell'app o da altro codice). */
export function asNavState(x: unknown): NavState | null {
  if (!x || typeof x !== "object") return null;
  const s = x as Record<string, unknown>;
  if (s.depth !== 0 && s.depth !== 1 && s.depth !== 2) return null;
  if (typeof s.tab !== "string" || !TABS.includes(s.tab as NavTab)) return null;
  const d = s.d === null || s.d === undefined ? null : typeof s.d === "string" && DEST_RE.test(s.d) ? s.d : undefined;
  if (d === undefined) return null;
  if (s.depth === 0 && s.tab !== "home") return null;
  if (s.depth === 2 && !d) return null;
  return { depth: s.depth, tab: s.tab as NavTab, d };
}

/** Scheda e destinazione dall'indirizzo; valori sconosciuti ignorati. */
export function readNavUrl(search: string): { v: NavTab | null; d: string | null } {
  const q = new URLSearchParams(search);
  const v = q.get("v");
  const d = q.get("d");
  return { v: v && TABS.includes(v as NavTab) && v !== "home" ? (v as NavTab) : null, d: d && DEST_RE.test(d) ? d : null };
}

/** Indirizzo (solo la parte dopo il percorso) per uno stato; gli altri parametri (es. debug) restano. */
export function navUrl(state: NavState, search: string): string {
  const q = new URLSearchParams(search);
  q.delete("v");
  q.delete("d");
  if (state.tab !== "home") q.set("v", state.tab);
  if (state.d) q.set("d", state.d);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Stato del livello 1 sotto una visita aperta senza passare dall'elenco (es. dalla Home): l'elenco delle destinazioni. */
export const LIST: NavState = { depth: 1, tab: "esplora", d: null };

export type NavStep =
  | { kind: "none" }
  | { kind: "replace" }
  /** Voci da aggiungere, nell'ordine: livelli intermedi e infine quello nuovo. */
  | { kind: "push"; states: NavState[] }
  /** Si torna indietro di `steps` voci, poi si sostituisce quella raggiunta con il nuovo stato. */
  | { kind: "back"; steps: number };

/** Come portare la cronologia dallo stato attuale a quello nuovo. */
export function navStep(current: NavState | null, next: NavState): NavStep {
  if (!current) return { kind: "replace" };
  if (sameNav(current, next)) return { kind: "none" };
  if (next.depth > current.depth) {
    const states: NavState[] = [];
    if (current.depth === 0 && next.depth === 2) states.push(LIST);
    states.push(next);
    return { kind: "push", states };
  }
  if (next.depth < current.depth) return { kind: "back", steps: current.depth - next.depth };
  return { kind: "replace" };
}

/**
 * Prima apertura (nessuno stato nella cronologia): voci da creare perché il back scenda di livello in livello.
 * La prima sostituisce la voce attuale, le altre si aggiungono.
 */
export function initialStack(target: NavState): NavState[] {
  if (target.depth === 0) return [HOME];
  if (target.depth === 1) return [HOME, target];
  return [HOME, LIST, target];
}
