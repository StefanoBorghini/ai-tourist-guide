/**
 * Prove di qualità delle risposte ibride: esegue le domande di un file di prova (nel Territory Pack)
 * con lo stesso codice della route e scrive un rapporto da rileggere a mano.
 *
 *   npm run ask:eval -- --file <percorso.json> [--only <id,id>] [--no-web] [--max-usd 2] [--dry] [--out rapporto.md]
 *
 * Senza --dry chiama davvero l'API (serve ANTHROPIC_API_KEY, ha un costo). Prima di partire stampa la
 * stima; si ferma prima di superare --max-usd (default 2 $), contando i costi stimati dal listino.
 * --no-web: solo base locale (fase A). --dry: solo cosa la base locale sa su ogni domanda, nessuna chiamata.
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
    "no-web": { type: "boolean", default: false },
    "max-usd": { type: "string", default: "2" },
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
const config = { ...webConfig(), ...(values["no-web"] ? { enabled: false } : {}) };
const maxUsd = Number(values["max-usd"]);
const only = values.only ? new Set(values.only.split(",")) : null;
const selected = spec.questions.filter((x) => !only || only.has(x.id));
// Stima prudente prima di spendere: ~0,04 $ a domanda locale, ~0,30 $ con ricerca (fascia alta).
const estimate = selected.reduce((sum, q) => sum + (q.expect === "web" && config.enabled ? 0.3 : 0.04), 0);
console.error(`${selected.length} domande · stima prudente ${estimate.toFixed(2)} $ · tetto di questa esecuzione ${maxUsd} $ · ricerca web ${config.enabled ? "attiva" : "spenta"}`);
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
const rows: { web: boolean; usd: number; input: number; cacheRead: number; cacheWrite: number; output: number }[] = [];
let stopped = "";
const summary: string[] = ["| Prova | Atteso | Esito | Origine | Ricerche | Fonti web | Parole | Costo $ |", "|---|---|---|---|---|---|---|---|"];

for (const q of selected) {
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
  const next = q.expect === "web" && config.enabled ? 0.3 : 0.04;
  if (totalUsd + next > maxUsd) {
    stopped = `Interrotto prima di «${q.id}»: speso ${totalUsd.toFixed(4)} $, la prossima prova potrebbe superare il tetto di ${maxUsd} $.`;
    console.error(stopped);
    break;
  }

  const started = Date.now();
  const outcome = await askGuide(client, loaded, req, { config, supported, permitted: () => true });
  const a = outcome.answer;
  const words = a.answer.split(/\s+/).filter(Boolean).length;
  const searches = outcome.usage.web?.webSearches ?? 0;
  const m = a.meter;
  if (m) rows.push({ web: outcome.usage.web !== undefined, usd: m.costUsd ?? 0, input: m.input, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, output: m.output });
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
  out.push(`**Consumi:** modelli ${m?.models.join(", ") ?? "?"} · chiamate ${m?.calls ?? "?"} · locale ${JSON.stringify(outcome.usage.local ?? null)}${outcome.usage.web ? ` · ricerca ${JSON.stringify(outcome.usage.web)}` : ""} · stima $${outcome.costUsd ?? "?"}`, "");
  console.error(`${q.id}: ${a.status}/${origin}, ${searches} ricerche, ${a.webSources?.length ?? 0} fonti, $${outcome.costUsd ?? "?"}`);
}

const group = (web: boolean) => {
  const r = rows.filter((x) => x.web === web);
  if (r.length === 0) return `- ${web ? "Con" : "Senza"} ricerca web: nessuna domanda`;
  const sum = (k: keyof (typeof r)[number]) => r.reduce((a, x) => a + Number(x[k]), 0);
  const inputAll = sum("input") + sum("cacheRead") + sum("cacheWrite");
  return `- ${web ? "Con" : "Senza"} ricerca web: ${r.length} domande · media ${(sum("usd") / r.length).toFixed(4)} $ · token in ingresso medi ${Math.round(inputAll / r.length)} (letti dalla cache ${inputAll ? Math.round((100 * sum("cacheRead")) / inputAll) : 0}%) · in uscita medi ${Math.round(sum("output") / r.length)}`;
};
if (client) {
  out.splice(
    4,
    0,
    "## Riepilogo",
    "",
    ...summary,
    "",
    group(false),
    group(true),
    `- Totale: ${rows.length} domande · ${totalSearches} ricerche · stima ${totalUsd.toFixed(4)} $ · media ${(rows.length ? totalUsd / rows.length : 0).toFixed(4)} $ a domanda`,
    "- Costi stimati dal listino pubblico sui token restituiti dall'API: il dato fatturato è nella Console Anthropic.",
    ...(stopped ? [`- ${stopped}`] : []),
    "",
  );
}
const report = out.join("\n");
if (values.out) writeFileSync(values.out, report);
else console.log(report);
