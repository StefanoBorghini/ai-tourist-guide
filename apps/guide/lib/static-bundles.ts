/**
 * Quali destinazioni si distribuiscono anche come bundle compilati dai file del repository (public/bundles/).
 *
 * L'elenco è esplicito (territories/static-bundles.json): una destinazione non elencata non ha bundle statici,
 * anche se nei file non dichiara contenuti a pagamento. I file del repository non conoscono la configurazione
 * salvata nello Studio, quindi un bundle statico è sicuro solo se la destinazione è tutta gratuita: per le
 * destinazioni elencate config.access è vietato nei file e la pubblicazione dallo Studio rifiuta i contenuti a
 * pagamento (lib/studio/publish.ts). Puro: usato dallo script di build e dai test.
 */
import type { TerritoryPack } from "@guide/domain";

export interface StaticBundlesList {
  destinations: string[];
}

/** Legge e controlla territories/static-bundles.json. */
export function parseStaticList(raw: unknown): StaticBundlesList {
  const list = (raw as { destinations?: unknown } | null)?.destinations;
  if (!Array.isArray(list) || list.some((d) => typeof d !== "string" || !d)) {
    throw new Error("static-bundles.json: serve «destinations», un elenco di identificativi");
  }
  return { destinations: [...new Set(list as string[])] };
}

export interface StaticBuildPlan {
  /** Destinazioni da compilare in public/bundles/. */
  build: string[];
  /** Destinazioni lasciate fuori, con il motivo (per il registro del build). */
  skipped: { id: string; reason: string }[];
  /** Errori che fermano il build. */
  errors: string[];
}

export function staticBuildPlan(packs: ReadonlyMap<string, TerritoryPack>, list: StaticBundlesList, includeFictional: boolean): StaticBuildPlan {
  const plan: StaticBuildPlan = { build: [], skipped: [], errors: [] };
  const listed = new Set(list.destinations);
  for (const id of listed) {
    const pack = packs.get(id);
    if (!pack) plan.errors.push(`static-bundles.json: ${id} non esiste in territories/`);
    else if (pack.manifest.kind !== "destination") plan.errors.push(`static-bundles.json: ${id} non è una destinazione`);
    else if (pack.config.access) {
      plan.errors.push(`${id}: una destinazione distribuita dai file non può dichiarare l'accesso a pagamento (config.access)`);
    }
  }
  for (const pack of packs.values()) {
    const id = pack.manifest.id;
    if (pack.manifest.kind !== "destination") continue;
    if (pack.manifest.fictional) {
      // Territori inventati: solo per le prove in locale, mai con contenuti a pagamento nei file statici.
      if (!includeFictional) plan.skipped.push({ id, reason: "territorio fittizio" });
      else if (pack.config.access) plan.skipped.push({ id, reason: "territorio fittizio con accesso a pagamento" });
      else plan.build.push(id);
    } else if (listed.has(id)) {
      if (!pack.config.access) plan.build.push(id);
    } else {
      plan.skipped.push({ id, reason: "non elencata in static-bundles.json: arriva solo dallo Studio" });
    }
  }
  plan.build.sort();
  return plan;
}

/**
 * La destinazione si può pubblicare dallo Studio con questi contenuti? Una destinazione con bundle statici
 * (o un elenco statico non leggibile: si rifiuta per prudenza) non può avere contenuti a pagamento, altrimenti
 * i file del repository li distribuirebbero comunque.
 */
export function premiumBlockedByStatic(destination: string, staticDestinations: ReadonlySet<string> | null): string | null {
  if (staticDestinations === null) {
    return "l'elenco dei bundle statici non è leggibile: i contenuti a pagamento non si pubblicano finché non si verifica";
  }
  if (staticDestinations.has(destination)) {
    return `${destination} è distribuita anche dai file del repository (territories/static-bundles.json): i contenuti a pagamento resterebbero pubblici. Toglila dall'elenco e ridistribuisci l'app prima di attivarli`;
  }
  return null;
}
