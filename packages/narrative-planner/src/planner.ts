import type { Audience, Locale, UnitType } from "@guide/domain";
import type { LibraryUnit, NarrativeLibrary } from "./library.ts";
import type { TourMemory } from "./memory.ts";

/**
 * Narrative Planner: decide COSA raccontare in una tappa, in modo deterministico.
 *
 * L'AI non sceglie i contenuti: riceve un piano esplicito (unità pre-registrate
 * più brevi raccordi) e al massimo rende i raccordi in linguaggio naturale.
 *
 * Regole:
 *  1. mai ripetere un'unità già ascoltata, né una le cui affermazioni sono già state raccontate;
 *  2. un'unità si racconta solo se i concetti che richiede sono già noti al visitatore;
 *     altrimenti si inserisce prima l'unità che li introduce, oppure la si scarta;
 *  3. si sta nel tempo disponibile per la tappa (sosta, cammino fino alla prossima, scadenza);
 *  4. si riprende un filo lasciato in una tappa precedente ("come promesso…");
 *  5. si richiama ciò che è stato visto prima ("prima, al borgo, abbiamo parlato di…");
 *  6. si lascia un gancio verso la tappa successiva, se è nota.
 */

/** Durata stimata di un raccordo breve, in secondi. */
export const BRIDGE_S = 4;

const TYPE_BASE: Record<UnitType, number> = {
  opening: 100,
  context: 60,
  detail: 50,
  legend: 45,
  curiosity: 40,
  transition: 20,
  closing: 10,
};

export interface StopRequest {
  library: NarrativeLibrary;
  memory: TourMemory;
  /** Luogo corrente, riferimento completo. */
  placeRef: string;
  locale: Locale;
  audience?: Audience;
  /** Tempo disponibile per il racconto in questa tappa, in secondi. */
  timeBudgetS: number;
  /** Prossima tappa del tour, se nota. */
  nextPlaceRef?: string | null;
}

export type PlanItem =
  | { kind: "unit"; unitRef: string; durationS: number; role: "main" | "prerequisite" }
  | { kind: "thread"; fromPlace: string | null; promise: string; durationS: number }
  | { kind: "callback"; conceptRef: string; fromPlace: string | null; durationS: number }
  | { kind: "hook"; target: string; text: string; durationS: number };

export type SkipReason = "heard" | "already_told" | "missing_prerequisite" | "budget";

export interface StopPlan {
  placeRef: string;
  locale: Locale;
  items: PlanItem[];
  totalS: number;
  skipped: { unitRef: string; reason: SkipReason }[];
}

interface Group {
  main: LibraryUnit;
  prerequisites: LibraryUnit[];
  callback: { conceptRef: string; fromPlace: string | null } | null;
  order: number;
}

export function planStop(req: StopRequest): StopPlan {
  const { library, memory, placeRef, locale } = req;
  const audience = req.audience ?? "general";
  const heard = new Set(memory.heardUnits);
  const told = new Set(memory.toldAssertions);
  const known = new Set(Object.keys(memory.introducedConcepts));
  const threadsHere = memory.openThreads.filter((t) => t.target === placeRef);
  const skipped: StopPlan["skipped"] = [];

  // 1. Candidati: unità del luogo, nella lingua giusta, per il pubblico richiesto o generale.
  // Le unità del pubblico richiesto hanno un bonus nel punteggio; quelle generali restano valide per tutti.
  const pool = (library.byAnchor.get(placeRef) ?? []).filter(
    (u) => u.locale === locale && (u.audience === audience || u.audience === "general"),
  );

  const candidates: LibraryUnit[] = [];
  for (const u of pool) {
    if (heard.has(u.ref)) skipped.push({ unitRef: u.ref, reason: "heard" });
    else if (u.assertions.every((a) => told.has(a))) skipped.push({ unitRef: u.ref, reason: "already_told" });
    else candidates.push(u);
  }

  // 2. Punteggio: tipo di unità, interessi, pubblico, fili da riprendere.
  const interest = (key: string) => memory.interests[key] ?? 0.5;
  const score = (u: LibraryUnit) =>
    TYPE_BASE[u.unitType] +
    interest(u.unitType) * 40 +
    u.introduces.concat(u.requires).reduce((s, c) => s + (interest(c) - 0.5) * 20, 0) +
    (u.audience === audience ? 15 : 0) +
    (threadsHere.length > 0 && u.unitType !== "opening" ? 10 : 0);
  candidates.sort((a, b) => score(b) - score(a) || a.ref.localeCompare(b.ref));

  // 3. Selezione con prerequisiti e budget di tempo.
  const groups: Group[] = [];
  const planned = new Set<string>();
  const plannedConcepts = new Set<string>();
  let used = threadsHere.length > 0 ? BRIDGE_S : 0;
  let callbackUsed = false;

  const isKnown = (c: string) => known.has(c) || plannedConcepts.has(c);

  /** Trova le unità che introducono i concetti mancanti (ricorsivamente, profondità limitata). */
  const resolvePrerequisites = (unit: LibraryUnit, depth = 0, chain: LibraryUnit[] = []): LibraryUnit[] | null => {
    const extra = new Set(chain.flatMap((p) => p.introduces));
    for (const concept of unit.requires) {
      if (isKnown(concept) || extra.has(concept)) continue;
      if (depth >= 3) return null;
      const options = (library.introducers.get(`${locale}|${concept}`) ?? [])
        .filter((p) => !heard.has(p.ref) && !planned.has(p.ref) && !chain.includes(p) && p !== unit)
        .sort((a, b) => Number(b.anchor === placeRef) - Number(a.anchor === placeRef) || a.durationS - b.durationS);
      let found = false;
      for (const option of options) {
        const deeper = resolvePrerequisites(option, depth + 1, chain);
        if (deeper) {
          chain = [...deeper, option];
          for (const c of option.introduces) extra.add(c);
          found = true;
          break;
        }
      }
      if (!found) return null;
    }
    return chain;
  };

  for (const unit of candidates) {
    if (planned.has(unit.ref)) continue;
    const prerequisites = resolvePrerequisites(unit);
    if (!prerequisites) {
      skipped.push({ unitRef: unit.ref, reason: "missing_prerequisite" });
      continue;
    }
    let callback: Group["callback"] = null;
    if (!callbackUsed) {
      const concept = unit.requires.find((c) => {
        const at = memory.introducedConcepts[c]?.atPlace;
        return at !== undefined && at !== placeRef;
      });
      if (concept) callback = { conceptRef: concept, fromPlace: memory.introducedConcepts[concept]!.atPlace };
    }
    const cost =
      unit.durationS + prerequisites.reduce((s, p) => s + p.durationS, 0) + (callback ? BRIDGE_S : 0);
    if (used + cost > req.timeBudgetS) {
      skipped.push({ unitRef: unit.ref, reason: "budget" });
      continue;
    }
    used += cost;
    if (callback) callbackUsed = true;
    for (const u of [...prerequisites, unit]) {
      planned.add(u.ref);
      for (const c of u.introduces) plannedConcepts.add(c);
    }
    groups.push({ main: unit, prerequisites, callback, order: groups.length });
  }

  // 4. Ordine: apertura per prima, chiusura per ultima, il resto per punteggio.
  const rank = (t: UnitType) => (t === "opening" ? 0 : t === "closing" ? 2 : 1);
  groups.sort((a, b) => rank(a.main.unitType) - rank(b.main.unitType) || a.order - b.order);

  const items: PlanItem[] = [];
  for (const g of groups) {
    for (const p of g.prerequisites) items.push({ kind: "unit", unitRef: p.ref, durationS: p.durationS, role: "prerequisite" });
    if (g.callback) items.push({ kind: "callback", ...g.callback, durationS: BRIDGE_S });
    items.push({ kind: "unit", unitRef: g.main.ref, durationS: g.main.durationS, role: "main" });
  }

  // 5. Filo da riprendere: subito dopo l'apertura (o all'inizio).
  if (threadsHere.length > 0 && groups.length > 0) {
    const thread = threadsHere[0]!;
    const afterOpening = groups[0]!.main.unitType === "opening" ? items.findIndex((i) => i.kind === "unit" && i.unitRef === groups[0]!.main.ref) + 1 : 0;
    items.splice(afterOpening, 0, { kind: "thread", fromPlace: thread.fromPlace, promise: thread.text, durationS: BRIDGE_S });
  } else if (threadsHere.length > 0) {
    used -= BRIDGE_S;
  }

  // 6. Gancio verso la prossima tappa.
  if (req.nextPlaceRef) {
    const hook = groups.flatMap((g) => [...g.prerequisites, g.main]).flatMap((u) => u.hooks).find((h) => h.target === req.nextPlaceRef);
    if (hook && used + BRIDGE_S <= req.timeBudgetS) {
      items.push({ kind: "hook", target: hook.target, text: hook.text, durationS: BRIDGE_S });
      used += BRIDGE_S;
    }
  }

  return { placeRef, locale, items, totalS: items.reduce((s, i) => s + i.durationS, 0), skipped };
}

/** Aggiorna la memoria dopo aver raccontato un piano (o la parte effettivamente ascoltata). */
export function applyStopPlan(memory: TourMemory, plan: StopPlan, library: NarrativeLibrary): TourMemory {
  const units = plan.items
    .filter((i): i is Extract<PlanItem, { kind: "unit" }> => i.kind === "unit")
    .map((i) => library.units.get(i.unitRef)!)
    .filter(Boolean);
  if (units.length === 0 && plan.items.length === 0) return memory;

  const introduced = { ...memory.introducedConcepts };
  for (const u of units) for (const c of u.introduces) introduced[c] ??= { atPlace: plan.placeRef };

  const hooks = plan.items.filter((i): i is Extract<PlanItem, { kind: "hook" }> => i.kind === "hook");
  const openThreads = [
    ...memory.openThreads.filter((t) => t.target !== plan.placeRef),
    ...hooks.map((h) => ({ target: h.target, fromPlace: plan.placeRef, text: h.text })),
  ];

  return {
    ...memory,
    visitedPlaces: memory.visitedPlaces.includes(plan.placeRef) ? memory.visitedPlaces : [...memory.visitedPlaces, plan.placeRef],
    heardUnits: [...new Set([...memory.heardUnits, ...units.map((u) => u.ref)])],
    toldAssertions: [...new Set([...memory.toldAssertions, ...units.flatMap((u) => u.assertions)])],
    introducedConcepts: introduced,
    openThreads,
  };
}
