/**
 * Mostra esattamente cosa riceverebbe il modello per una domanda, senza chiamarlo (nessuna chiave
 * necessaria, nessun costo). Usa lo stesso codice della route /api/guide/ask e i bundle compilati in
 * public/bundles (prima: `npm run bundles`).
 *
 *   npm run ask:context -- --destination <id> [--locale it] [--place <slug>] [--selected <slug>]
 *                          [--at <slug>] [--full] "domanda"
 *
 * --place è il luogo in cui ci si trova, --selected quello scelto sulla mappa, --at mette la posizione
 * del visitatore sulle coordinate di un luogo (per le distanze). --full stampa anche la base intera.
 */
import { parseArgs } from "node:util";
import { loadKnowledge } from "../lib/ask-server";
import { SYSTEM_PROMPT, askRequestSchema, buildQuestionMessage, positionContext } from "../lib/ask";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    destination: { type: "string" },
    locale: { type: "string", default: "it" },
    place: { type: "string" },
    selected: { type: "string" },
    at: { type: "string" },
    full: { type: "boolean", default: false },
  },
});
const question = positionals.join(" ").trim();
if (!values.destination || question.length < 2) {
  console.error('Uso: npm run ask:context -- --destination <id> [--place <slug>] [--selected <slug>] [--at <slug>] [--full] "domanda"');
  process.exit(2);
}
const destination = values.destination;
const loaded = await loadKnowledge(destination, values.locale!);
if (!loaded) {
  console.error(`Bundle non trovato: ${destination}/${values.locale}. Esegui prima \`npm run bundles\`.`);
  process.exit(1);
}
const ref = (slug?: string) => (slug ? (slug.includes(":") ? slug : `${destination}:${slug}`) : null);
const placeAt = ref(values.at);
const location = placeAt ? loaded.content.places.find((p) => p.ref === placeAt)?.location : undefined;
if (placeAt && !location) {
  console.error(`Luogo sconosciuto: ${placeAt}`);
  process.exit(1);
}
const req = askRequestSchema.parse({
  destination,
  locale: values.locale,
  question,
  currentPlace: ref(values.place),
  selectedPlace: ref(values.selected),
  position: location ? { lon: location[0], lat: location[1], accuracyM: 8 } : null,
});

const about = [req.selectedPlace, req.currentPlace].filter((r): r is string => !!r);
const relevant = loaded.content.assertions.filter((a) => about.includes(a.subject));
console.log(`# Contesto per il modello — ${destination}/${values.locale}`);
console.log(`base: ${loaded.kbHash.slice(0, 12)} · ${loaded.content.assertions.length} affermazioni · ${loaded.knowledge.length} caratteri · istruzioni ${SYSTEM_PROMPT.length} caratteri`);
if (about.length > 0) {
  console.log(`affermazioni sul luogo indicato: ${relevant.length}`);
  for (const a of relevant) console.log(`  - ${a.ref.split(":").pop()} [${a.type}${a.inReview ? ", in revisione" : ""}${a.sourceUnconfirmed ? ", fonte da confermare" : ""}] ${a.text}`);
}
if (positionContext(loaded.content, req) === null) console.log("posizione: non indicata (usa --at <luogo> per le distanze)");
console.log("\n## Istruzioni (system, 1/2)\n" + (values.full ? SYSTEM_PROMPT : SYSTEM_PROMPT.slice(0, 300) + "… (--full per tutto)"));
console.log("\n## Base di conoscenza (system, 2/2)\n" + (values.full ? loaded.knowledge : loaded.knowledge.split("\n").slice(0, 6).join("\n") + "\n… (--full per tutto)"));
console.log("\n## Messaggio\n" + buildQuestionMessage(loaded.content, req));
