import type { Locale } from "@guide/domain";
import type { NarrativeLibrary } from "./library.ts";
import type { PlanItem } from "./planner.ts";

/**
 * Raccordi "a modello": frasi brevi e prudenti usate quando non c'è rete
 * (o come base per il renderer AI, che le rende più naturali).
 * Non contengono fatti: solo collegamenti tra cose già raccontate.
 */

type BridgeItem = Exclude<PlanItem, { kind: "unit" }>;

const TEMPLATES: Record<"it" | "en", {
  callbackAt: string;
  callback: string;
  threadAt: string;
  thread: string;
}> = {
  it: {
    callbackAt: "Ti ricordi? A {place} abbiamo parlato di {concept}.",
    callback: "Ti ricordi? Ne abbiamo già parlato: {concept}.",
    threadAt: "Come ti avevo promesso a {from}, eccoci qui.",
    thread: "Come ti avevo promesso, eccoci qui.",
  },
  en: {
    callbackAt: "Remember? At {place} we talked about {concept}.",
    callback: "Remember? We already talked about this: {concept}.",
    threadAt: "As I promised at {from}, here we are.",
    thread: "As I promised, here we are.",
  },
};

function label(library: NarrativeLibrary, ref: string | null, locale: Locale): string | null {
  if (!ref) return null;
  const names = library.labels.get(ref);
  return names?.[locale] ?? names?.it ?? names?.en ?? null;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
}

export function renderBridgeTemplate(item: BridgeItem, locale: Locale, library: NarrativeLibrary): string {
  const t = TEMPLATES[locale === "it" ? "it" : "en"];
  switch (item.kind) {
    case "hook":
      return item.text;
    case "callback": {
      const concept = label(library, item.conceptRef, locale) ?? "";
      const place = label(library, item.fromPlace, locale);
      return place ? fill(t.callbackAt, { place, concept }) : fill(t.callback, { concept });
    }
    case "thread": {
      const from = label(library, item.fromPlace, locale);
      return from ? fill(t.threadAt, { from }) : t.thread;
    }
  }
}
