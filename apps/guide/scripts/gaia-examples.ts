/**
 * Esempi di riferimento di Gaia (docs/v0.4-gaia/ESEMPI.md): controllo ed esportazione per l'allenamento.
 *
 *   npm run gaia:examples -- --file <GAIA-EXAMPLES.json> [--out allenamento.jsonl] [--include-drafts] [--pack <cartella> [--full]]
 *
 * Senza --out controlla ogni esempio con le regole della produzione e con le attese della domanda di
 * prova, e termina con errore se uno non passa. Con --out scrive gli esempi in JSONL (un esempio per
 * riga, formato a messaggi system/user/assistant) per il fine-tuning di un modello aperto: solo quelli
 * approvati dalla redazione, salvo --include-drafts (solo per prove, mai per un allenamento vero).
 * --pack <cartella> [--full]: controlla gli esempi su una base compilata in locale (come ask:eval, lib/eval-knowledge.ts)
 * invece che sul bundle pubblicato; --full include i contenuti a pagamento, solo per la valutazione locale.
 * Nessuna chiamata a modelli, nessun costo.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadKnowledge } from "../lib/ask-server";
import { loadPackKnowledge } from "../lib/eval-knowledge";
import { checkExample, examplesFileSchema, toTrainingRecord, type EvalCase } from "../lib/gaia-examples";

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    out: { type: "string" },
    "include-drafts": { type: "boolean", default: false },
    pack: { type: "string" },
    full: { type: "boolean", default: false },
  },
});
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
if (!values.file) fail("uso: npm run gaia:examples -- --file <GAIA-EXAMPLES.json> [--out allenamento.jsonl] [--include-drafts]");

const file = resolve(values.file!);
const spec = examplesFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
const questionsFile = JSON.parse(readFileSync(resolve(dirname(file), spec.questions), "utf8")) as { destination: string; locale: string; questions: EvalCase[] };
if (questionsFile.destination !== spec.destination || questionsFile.locale !== spec.locale) fail("domande ed esempi di destinazioni o lingue diverse");
const cases = new Map(questionsFile.questions.map((q) => [q.id, q]));

if (values.full && !values.pack) fail("--full vale solo con --pack <cartella>: la base completa si compila solo in locale.");
const fromPack = values.pack ? loadPackKnowledge(resolve(values.pack), spec.destination, spec.locale, { full: values.full }) : null;
const kb = fromPack ?? (await loadKnowledge(spec.destination, spec.locale));
console.log(`base: ${fromPack?.label ?? "bundle pubblicato"}${kb ? ` · ${kb.content.assertions.length} affermazioni` : ""}`);
if (!kb) fail(`bundle non trovato: ${spec.destination}/${spec.locale} (serve npm run bundles -w @guide/app)`);
const { content } = kb!;

const seen = new Set<string>();
let failed = 0;
for (const ex of spec.examples) {
  const q = cases.get(ex.id);
  const check = !q ? null : checkExample(content, spec.locale, q, ex);
  const problems = !q ? ["nessuna domanda di prova con questo id"] : seen.has(ex.id) ? ["id ripetuto"] : check!.problems;
  seen.add(ex.id);
  if (problems.length > 0) {
    failed++;
    console.log(`✗ ${ex.id}: ${problems.join("; ")}`);
  }
  for (const w of check?.warnings ?? []) console.log(`! ${ex.id}: ${w}`);
}
const missing = [...cases.keys()].filter((id) => !seen.has(id));
const approved = spec.examples.filter((e) => e.approved).length;
console.log(
  `${spec.examples.length} esempi · ${spec.examples.length - failed} superano i controlli · ${approved} approvati dalla redazione` +
    (missing.length ? ` · ${missing.length} domande senza esempio` : ""),
);

if (values.out) {
  if (failed > 0) fail("esportazione annullata: correggi prima gli esempi che non superano i controlli");
  const chosen = spec.examples.filter((e) => e.approved || values["include-drafts"]);
  if (chosen.length === 0) fail("nessun esempio approvato da esportare (--include-drafts solo per prove)");
  writeFileSync(values.out, chosen.map((e) => JSON.stringify(toTrainingRecord(content, spec.locale, cases.get(e.id)!, e))).join("\n") + "\n");
  console.log(`${chosen.length} esempi scritti in ${values.out}${values["include-drafts"] ? " (comprese le bozze: non usarli per un allenamento vero)" : ""}`);
} else if (failed > 0) {
  process.exit(1);
}
