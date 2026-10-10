/**
 * Prove di qualità delle risposte ibride: esegue le domande di un file di prova (nel Territory Pack)
 * con lo stesso codice della route e scrive un rapporto da rileggere a mano.
 *
 *   npm run ask:eval -- --file <percorso.json> [--only <id>] [--dry] [--out rapporto.md]
 *
 * Senza --dry chiama davvero l'API (serve ANTHROPIC_API_KEY, ha un costo: lo stima alla fine).
 * Con --dry mostra solo cosa la base locale sa su ogni domanda, senza chiamare nessuno.
 *
 * Il rapporto non giudica la qualità da solo: riporta per ogni domanda le informazioni locali, se è
 * stata fatta la ricerca, le fonti (con dominio e livello), i numeri da verificare, i token e il costo.
 * Pertinenza delle citazioni e affermazioni non supportate vanno controllate leggendo le fonti.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { askRequestSchema } from "../lib/ask";
import { ASK_MODEL, askGuide, loadKnowledge, webSearchSupported } from "../lib/ask-server";
import { webConfig } from "../lib/ask-web";

interface EvalQuestion {
  id: string;
  category: string;
  question: string;
  place?: string;
  selected?: string;
  at?: string;
  depth?: "auto" | "deep";
  expect: "local" | "web" | "none";
  check: string;
}

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    only: { type: "string" },
    dry: { type: "boolean", default: false },
    out: { type: "string" },
  },
});
if (!values.file) {
  console.error("Uso: npm run ask:eval -- --file <percorso.json> [--only <id>] [--dry] [--out rapporto.md]");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(values.file, "utf8")) as { destination: string; locale: "it" | "en"; questions: EvalQuestion[] };
const loaded = await loadKnowledge(spec.destination, spec.locale);
if (!loaded) {
  console.error(`Bundle non trovato: ${spec.destination}/${spec.locale}. Esegui prima \`npm run bundles\`.`);
  process.exit(1);
}
if (!values.dry && !process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY non impostata: usa --dry per vedere solo il contesto locale.");
  process.exit(2);
}

const ref = (slug?: string) => (slug ? (slug.includes(":") ? slug : `${spec.destination}:${slug}`) : null);
const config = webConfig();
const client = values.dry ? null : new Anthropic();
const supported = client ? await webSearchSupported(client, config.model) : null;
const out: string[] = [
  `# Prove delle risposte ibride — ${spec.destination}/${spec.locale}`,
  "",
  `Base: \`${loaded.kbHash.slice(0, 12)}\` · ${loaded.content.assertions.length} affermazioni · modello locale ${ASK_MODEL} · modello con ricerca ${config.model} · max ${config.maxUses} ricerche · ricerca supportata (Models API): ${supported ?? "non verificato"}`,
  "",
];
let totalUsd = 0;
let totalSearches = 0;
const summary: string[] = ["| Prova | Atteso | Esito | Origine | Ricerche | Fonti web | Parole | Costo $ |", "|---|---|---|---|---|---|---|---|"];

for (const q of spec.questions.filter((x) => !values.only || x.id === values.only)) {
  const at = ref(q.at);
  const location = at ? loaded.content.places.find((p) => p.ref === at)?.location : undefined;
  const req = askRequestSchema.parse({
    destination: spec.destination,
    locale: spec.locale,
    question: q.question,
    currentPlace: ref(q.place) ?? at,
    selectedPlace: ref(q.selected),
    position: location ? { lon: location[0], lat: location[1], accuracyM: 8, simulated: true } : null,
    depth: q.depth ?? "auto",
  });
  const about = [req.selectedPlace, req.currentPlace].filter((r): r is string => !!r);
  const localFacts = loaded.content.assertions.filter((a) => about.includes(a.subject));
  out.push(`## ${q.id} — ${q.category}`, "", `**Domanda:** ${q.question}${q.depth === "deep" ? " _(approfondimento)_" : ""}`, "", `**Da verificare:** ${q.check}`, "");
  out.push(`**Informazioni locali sul luogo (${localFacts.length}):** ${localFacts.map((a) => `\`${a.ref.split(":").pop()}\``).join(", ") || "nessuna"}`, "");
  if (!client) continue;

  const started = Date.now();
  const outcome = await askGuide(client, loaded, req, { config, supported, permitted: () => true });
  const a = outcome.answer;
  const words = a.answer.split(/\s+/).filter(Boolean).length;
  const searches = (outcome.usage.web?.webSearches ?? 0) + outcome.usage.local.webSearches;
  totalUsd += outcome.costUsd ?? 0;
  totalSearches += searches;
  const origin = a.origin ?? "local";
  const asExpected = q.expect === "none" ? searches === 0 : q.expect === origin;
  summary.push(`| ${q.id} | ${q.expect} | ${a.status} | ${origin}${asExpected ? "" : " ⚠"} | ${searches} | ${a.webSources?.length ?? 0} | ${words} | ${outcome.costUsd ?? "?"} |`);
  out.push(
    `**Esito:** ${a.status} · origine ${origin} · ${words} parole · ${((Date.now() - started) / 1000).toFixed(1)} s${a.webUnavailable ? " · ricerca NON disponibile" : ""}${outcome.rejected ? ` · scarto locale: ${outcome.rejected}` : ""}`,
    "",
    "**Risposta:**",
    "",
    ...a.answer.split(/\n{2,}/).map((p) => `> ${p}\n>`),
    "",
    `**Affermazioni della base citate:** ${a.citations.map((c) => `\`${c.split(":").pop()}\``).join(", ") || "nessuna"}`,
    "",
  );
  if (a.webSources?.length) {
    out.push("**Fonti web citate:**", "");
    for (const s of a.webSources) out.push(`- [${s.title}](${s.url}) — ${s.site} · livello ${s.tier}${s.pageAge ? ` · ${s.pageAge}` : ""}${s.citedText ? `\n  «${s.citedText}»` : ""}`);
    out.push("");
  }
  if (a.unsupportedNumbers?.length) out.push(`**Numeri da verificare (non ritrovati nei brani citati):** ${a.unsupportedNumbers.join(", ")}`, "");
  if (outcome.web?.unknownRefs?.length) out.push(`**Riferimenti della base inesistenti (tolti):** ${outcome.web.unknownRefs.join(", ")}`, "");
  if (outcome.web?.error) out.push(`**Errore ricerca:** ${outcome.web.error}`, "");
  out.push(`**Consumi:** locale ${JSON.stringify(outcome.usage.local)}${outcome.usage.web ? ` · ricerca ${JSON.stringify(outcome.usage.web)}` : ""} · stima $${outcome.costUsd ?? "?"}`, "");
  console.error(`${q.id}: ${a.status}/${origin}, ${searches} ricerche, ${a.webSources?.length ?? 0} fonti, $${outcome.costUsd ?? "?"}`);
}

if (client) out.splice(4, 0, "## Riepilogo", "", ...summary, "", `Totale: ${totalSearches} ricerche · stima $${totalUsd.toFixed(4)}`, "");
const report = out.join("\n");
if (values.out) writeFileSync(values.out, report);
else console.log(report);
