/**
 * Base di conoscenza per la valutazione LOCALE (`ask:eval --pack`, `gaia:examples --pack`): compila il bundle
 * da una cartella di Territory Pack sul disco di chi esegue la prova, invece di leggere quello pubblicato.
 *
 * Serve a confrontare i modelli sulla base vera: la fotografia del database esportata con
 * `guide-pack db-export`, oppure i file del repository. Con `full` la base comprende anche i contenuti che
 * in produzione sono a pagamento (config.access ignorato), perché le suite di prova sono scritte sulla base
 * completa.
 *
 * Sicurezza dei contenuti a pagamento: questo modulo lo importano SOLO gli script di valutazione. La route
 * delle domande e ask-server.ts non lo usano (lo verifica test/eval-knowledge.test.ts): il percorso dei
 * visitatori resta il bundle pubblico pubblicato. Niente rete, niente scritture: legge una cartella e compila
 * in memoria. I file media non si leggono e non si controllano (la base di conoscenza non li usa).
 */
import { buildBundle } from "@guide/bundle";
import { loadPacks } from "@guide/territory-pack";
import { buildKnowledge } from "./ask";
import type { Loaded } from "./ask-server";

export interface PackKnowledge extends Loaded {
  /** Quale base è stata usata, per il rapporto: cartella e base pubblica o completa. */
  label: string;
}

/** `allowFictional`: solo per i test sui territori inventati (come in buildBundle). */
export function loadPackKnowledge(dir: string, destination: string, locale: "it" | "en", opts: { full: boolean; allowFictional?: boolean }): PackKnowledge {
  const { packs } = loadPacks(dir);
  const dest = packs.get(destination);
  if (!dest) throw new Error(`destinazione ${destination} non trovata in ${dir}`);
  let scope = packs;
  if (opts.full && dest.config.access) {
    // Copia in memoria senza config.access: nessun file viene modificato.
    const { access: _access, ...config } = dest.config;
    scope = new Map(packs);
    scope.set(destination, { ...dest, config });
  }
  const built = buildBundle(scope, { destination, locale, fileExists: () => true, allowFictional: opts.allowFictional === true });
  const { content } = built;
  return {
    content,
    knowledge: buildKnowledge(content),
    kbHash: built.manifest.kbHash,
    label: `${dir} · base ${opts.full ? "completa (contenuti a pagamento inclusi, solo valutazione locale)" : "pubblica"}`,
  };
}
