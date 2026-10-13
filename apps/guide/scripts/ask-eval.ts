/**
 * Prove di qualità e costo delle risposte ibride: esegue le domande di uno o più file di prova (nel
 * Territory Pack) con lo stesso codice della route e scrive un rapporto da rileggere a mano.
 *
 *   npm run ask:eval -- --file <percorso.json> [--file <altro.json>] [--only <id,id>] [--no-web]
 *                       [--web-model <id>] [--web-max-uses <n>] [--max-usd 2] [--max-usd-per-question 0.5]
 *                       [--dry] [--out rapporto.md] [--json risultati.json]
 *
 * Senza --dry chiama davvero l'API (serve ANTHROPIC_API_KEY, ha un costo). Due tetti, entrambi stime:
 * - per domanda: --max-usd-per-question, oppure ASK_MAX_USD_PER_QUESTION (obbligatorio, come nella
 *   route): ogni chiamata passa dal budget della domanda (lib/ask-cost.ts);
 * - per l'esecuzione: --max-usd (default 2 $): prima di ogni domanda si tiene libero l'intero budget
 *   per domanda e non la si fa se totale + budget supera il tetto.
 * Il budget non è un tetto matematico: i token dei risultati della prima ricerca non si conoscono prima
 * della risposta. Il limite rigido resta il limite di spesa del workspace nella Console Anthropic.
 * I costi sono stimati dal listino sui token restituiti dall'API; una domanda fallita conta la sua
 * stima prudente. Una domanda già partita non si può interrompere a metà.
 * --no-web: solo base locale (fase A). --web-model: modello della ricerca (come ASK_WEB_MODEL).
 * --web-max-uses: ricerche per domanda (come ASK_WEB_MAX_USES), per confrontare 1 e 3.
 * --json: risultati per domanda, da confrontare con `npm run ask:compare -- a.json b.json`.
 * --dry: solo cosa la base locale sa su ogni domanda, nessuna chiamata.
 *
 * Il rapporto non giudica la qualità da solo: riporta per ogni domanda le informazioni locali, se è
 * stata fatta la ricerca, le fonti (con dominio e livello), i numeri da verificare, i token e il costo.
 * Pertinenza delle citazioni e affermazioni non supportate vanno controllate leggendo le fonti.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { askRequestSchema, type AskAnswer } from "../lib/ask";
import { QuestionBudget, questionBudgetConfig, type BudgetSummary, type CallRecord, type CostQuality } from "../lib/ask-cost";
import { formatStats, stats } from "../lib/ask-eval-stats";
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

/** Un risultato per domanda nel file --json (letto da ask:compare). */
export interface EvalResult {
  id: string;
  question: string;
  category: string;
  expect: EvalQuestion["expect"];
  depth: "auto" | "deep";
  webModel: string | null;
  ms: number;
  answer: AskAnswer;
  costUsd: number;
  costQuality: CostQuality;
  budget: BudgetSummary;
  calls: CallRecord[];
  searches: number;
  rounds: number;
  error?: string;
}

const { values } = parseArgs({
  options: {
    file: { type: "string", multiple: true },
    only: { type: "string" },
    dry: { type: "boolean", default: false },
    "no-web": { type: "boolean", default: false },
    "max-usd": { type: "string", default: "2" },
    "max-usd-per-question": { type: "string" },
    "web-model": { type: "string" },
    "web-max-uses": { type: "string" },
    json: { type: "string" },
    out: { type: "string" },
  },
});
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};
if (!values.file?.length) fail("Uso: npm run ask:eval -- --file <percorso.json> [--file <altro.json>] [--only <id>] [--dry] [--out rapporto.md]");
const specs = values.file!.map((f) => JSON.parse(readFileSync(f, "utf8")) as { destination: string; locale: "it" | "en"; questions: EvalQuestion[] });
const spec = specs[0]!;
if (specs.some((s) => s.destination !== spec.destination || s.locale !== spec.locale)) fail("I file di prova devono avere la stessa destinazione e la stessa lingua.");
const allQuestions = specs.flatMap((s) => s.questions);
const dup = allQuestions.find((q, i) => allQuestions.findIndex((x) => x.id === q.id) !== i);
if (dup) fail(`Domanda ripetuta nei file di prova: ${dup.id}`);

const loaded = await loadKnowledge(spec.destination, spec.locale);
if (!loaded) fail(`Bundle non trovato: ${spec.destination}/${spec.locale}. Esegui prima \`npm run bundles\`.`);
if (!values.dry && !process.env.ANTHROPIC_API_KEY) fail("ANTHROPIC_API_KEY non impostata: usa --dry per vedere solo il contesto locale.");
const kb = loaded!;

const ref = (slug?: string) => (slug ? (slug.includes(":") ? slug : `${spec.destination}:${slug}`) : null);
const base = webConfig();
const maxUses = values["web-max-uses"] === undefined ? base.maxUses : Number(values["web-max-uses"]);
if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10) fail("--web-max-uses deve essere un intero da 1 a 10");
const config = {
  ...base,
  maxUses,
  ...(values["web-model"] ? { model: values["web-model"] } : {}),
  ...(values["no-web"] ? { enabled: false } : {}),
};
const maxUsd = Number(values["max-usd"]);
if (!(maxUsd > 0)) fail("--max-usd deve essere un numero positivo");
const perQuestion = questionBudgetConfig(
  values["max-usd-per-question"] === undefined ? process.env : { ASK_MAX_USD_PER_QUESTION: values["max-usd-per-question"] },
);
if (!values.dry && !perQuestion.ok) fail(`${perQuestion.ok ? "" : perQuestion.error} (o --max-usd-per-question)`);
const perQuestionUsd = perQuestion.ok ? perQuestion.maxUsd : 0;
if (!values.dry && perQuestionUsd > maxUsd) fail("Il budget per domanda supera il tetto dell'esecuzione (--max-usd): nessuna domanda partirebbe.");

const only = values.only ? new Set(values.only.split(",")) : null;
const selected = allQuestions.filter((x) => !only || only.has(x.id));
console.error(
  `${selected.length} domande · budget stimato ${perQuestionUsd || "—"} $ a domanda · tetto ${maxUsd} $ · ricerca ${config.enabled ? `attiva (${config.model}, max ${config.maxUses} ricerche, effort ${config.effort})` : "spenta"}`,
);
// Nessun nuovo tentativo automatico, come nella route.
const client = values.dry ? null : new Anthropic({ maxRetries: 0 });
const supported = client ? await webSearchSupported(client, config.model) : null;
const out: string[] = [
  `# Prove delle risposte ibride — ${spec.destination}/${spec.locale}`,
  "",
  `Base: \`${kb.kbHash.slice(0, 12)}\` · ${kb.content.assertions.length} affermazioni · modello locale ${ASK_MODEL} · modello con ricerca ${config.model} · max ${config.maxUses} ricerche · effort ${config.effort} · budget stimato per domanda ${perQuestionUsd || "—"} $ · ricerca supportata (Models API): ${supported ?? "non verificato"}`,
  "",
];
let totalUsd = 0;
let totalSearches = 0;
let stopped = "";
const results: EvalResult[] = [];
const summary: string[] = ["| Prova | Atteso | Esito | Origine | Ricerche | Giri | Fonti web | Parole | Costo $ |", "|---|---|---|---|---|---|---|---|---|"];

for (const q of selected) {
  const at = ref(q.at);
  const location = at ? kb.content.places.find((p) => p.ref === at)?.location : undefined;
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
  const localFacts = kb.content.assertions.filter((a) => about.includes(a.subject));
  out.push(`## ${q.id} — ${q.category}`, "", `**Domanda:** ${q.question}${q.depth === "deep" ? " _(approfondimento)_" : ""}`, "", `**Da verificare:** ${q.check}`, "");
  out.push(`**Informazioni locali sul luogo (${localFacts.length}):** ${localFacts.map((a) => `\`${a.ref.split(":").pop()}\``).join(", ") || "nessuna"}`, "");
  if (!client) continue;
  if (totalUsd + perQuestionUsd > maxUsd) {
    stopped = `Interrotto prima di «${q.id}»: speso ${totalUsd.toFixed(4)} $, la prossima prova potrebbe superare il tetto di ${maxUsd} $.`;
    console.error(stopped);
    break;
  }

  const started = Date.now();
  const budget = new QuestionBudget(perQuestionUsd);
  let outcome: Awaited<ReturnType<typeof askGuide>>;
  try {
    outcome = await askGuide(client, kb, req, { config, supported, permitted: () => true }, budget);
  } catch (error) {
    // Errore dell'API (credito esaurito, limite, rete): si conta ciò che è stato speso o stimato e ci si ferma.
    totalUsd += budget.spentUsd;
    const message = (error as Error).message.slice(0, 300);
    stopped = `Interrotto a «${q.id}» per un errore dell'API: ${message} (costo contato: ${budget.spentUsd} $, ${budget.quality})`;
    console.error(stopped);
    out.push(`**Errore:** ${message}`, "");
    break;
  }
  const a = outcome.answer;
  const ms = Date.now() - started;
  const searches = outcome.web?.searches ?? 0;
  const rounds = outcome.web?.rounds ?? 0;
  results.push({
    id: q.id,
    question: q.question,
    category: q.category,
    expect: q.expect,
    depth: req.depth,
    webModel: outcome.usage.web ? (a.meter?.models.at(-1) ?? config.model) : null,
    ms,
    answer: a,
    costUsd: outcome.costUsd,
    costQuality: outcome.costQuality,
    budget: outcome.budget,
    calls: outcome.calls,
    searches,
    rounds,
    ...(outcome.web?.error ? { error: outcome.web.error } : {}),
  });
  totalUsd += outcome.costUsd;
  totalSearches += searches;
  const words = a.answer.split(/\s+/).filter(Boolean).length;
  const origin = a.origin ?? "local";
  const asExpected = q.expect === "none" ? searches === 0 : q.expect === origin;
  const quality = outcome.costQuality === "measured" ? "" : ` (${outcome.costQuality})`;
  summary.push(`| ${q.id} | ${q.expect} | ${a.status} | ${origin}${asExpected ? "" : " ⚠"} | ${searches} | ${rounds} | ${a.webSources?.length ?? 0} | ${words} | ${outcome.costUsd}${quality} |`);
  out.push(
    `**Esito:** ${a.status} · origine ${origin} · ${words} parole · ${(ms / 1000).toFixed(1)} s${a.webUnavailable ? " · ricerca NON disponibile" : ""}${outcome.rejected ? ` · scarto locale: ${outcome.rejected}` : ""}${outcome.budget.stop ? ` · fermata dal budget: ${outcome.budget.stop}` : ""}`,
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
  out.push("**Chiamate:**", "");
  for (const c of outcome.calls) {
    const u = c.usage;
    out.push(
      `- ${c.kind}${c.round ? ` giro ${c.round}` : ""} · ${c.models.join(", ")} · max_tokens ${c.maxTokens} · ricerche concesse ${c.searchesAllowed} · ${c.outcome}${c.error ? ` (${c.error})` : ""} · ${u ? `in ${u.input} + cache letti ${u.cacheRead} + scritti ${u.cacheWrite} · out ${u.output} · ricerche ${u.webSearches}` : "consumi non restituiti"} · ${c.usd} $ (${c.quality})`,
    );
  }
  out.push("");
  console.error(`${q.id}: ${a.status}/${origin}, ${searches} ricerche, ${rounds} giri, ${a.webSources?.length ?? 0} fonti, $${outcome.costUsd} (${outcome.costQuality})`);
}

const group = (label: string, rows: EvalResult[]) => {
  if (rows.length === 0) return `- ${label}: nessuna domanda`;
  const sum = (f: (r: EvalResult) => number) => rows.reduce((t, r) => t + f(r), 0);
  const inputs = rows.map((r) => r.calls.reduce((t, c) => t + (c.usage ? c.usage.input + c.usage.cacheRead + c.usage.cacheWrite : 0), 0));
  const cacheRead = sum((r) => r.calls.reduce((t, c) => t + (c.usage?.cacheRead ?? 0), 0));
  const inputAll = inputs.reduce((t, n) => t + n, 0);
  return [
    `- ${label}: costo $ ${formatStats(stats(rows.map((r) => r.costUsd)))}`,
    `  - token in ingresso ${formatStats(stats(inputs), 0)} (letti dalla cache ${inputAll ? Math.round((100 * cacheRead) / inputAll) : 0}%)`,
    `  - token in uscita ${formatStats(stats(rows.map((r) => r.calls.reduce((t, c) => t + (c.usage?.output ?? 0), 0))), 0)}`,
    `  - ricerche ${formatStats(stats(rows.map((r) => r.searches)), 0)} · giri ${formatStats(stats(rows.map((r) => r.rounds)), 0)}`,
    `  - tempo s ${formatStats(stats(rows.map((r) => r.ms / 1000)), 1)}`,
  ].join("\n");
};
if (client) {
  const notMeasured = results.filter((r) => r.costQuality !== "measured").length;
  out.splice(
    4,
    0,
    "## Riepilogo",
    "",
    ...summary,
    "",
    group("Domande normali (attese senza ricerca)", results.filter((r) => r.expect !== "web")),
    group("Domande che richiedono la ricerca (attese)", results.filter((r) => r.expect === "web")),
    group("Risposte con origine web (osservate)", results.filter((r) => r.answer.origin === "web")),
    `- Totale: ${results.length} domande · ${totalSearches} ricerche · stima ${totalUsd.toFixed(4)} $ · media ${(results.length ? totalUsd / results.length : 0).toFixed(4)} $ a domanda`,
    `- Fermate dal budget: ${results.filter((r) => r.budget.stop).length} · risposte non disponibili: ${results.filter((r) => r.answer.status === "unavailable").length} · ricerca non disponibile o fallita: ${results.filter((r) => r.answer.webUnavailable).length}`,
    "- Costi stimati dal listino pubblico sui token restituiti dall'API: il dato fatturato è nella Console Anthropic.",
    ...(notMeasured ? [`- ${notMeasured} domande con costo non misurato (consumi mancanti o modello fuori listino): contato il caso peggiore stimato.`] : []),
    ...(stopped ? [`- ${stopped}`] : []),
    "",
  );
}
if (values.json) {
  writeFileSync(
    values.json,
    JSON.stringify(
      {
        destination: spec.destination,
        kbHash: kb.kbHash,
        localModel: ASK_MODEL,
        webModel: config.enabled ? config.model : null,
        webMaxUses: config.enabled ? config.maxUses : null,
        webEffort: config.enabled ? config.effort : null,
        maxUsdPerQuestion: perQuestionUsd,
        maxUsd,
        totalUsd,
        stopped: stopped || null,
        results,
      },
      null,
      2,
    ),
  );
}
const report = out.join("\n");
if (values.out) writeFileSync(values.out, report);
else console.log(report);
