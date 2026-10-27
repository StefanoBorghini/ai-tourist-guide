/**
 * Prove di qualità e costo delle risposte ibride: esegue le domande di uno o più file di prova (nel
 * Territory Pack) con lo stesso codice della route e scrive un rapporto da rileggere a mano.
 *
 *   npm run ask:eval -- --file <percorso.json> [--file <altro.json>] [--only <id,id>] [--area <area,area>]
 *                       [--no-web] [--web-model <id>] [--web-max-uses <n>] [--max-usd 2]
 *                       [--max-usd-per-question 0.5] [--dry] [--out rapporto.md] [--json risultati.json]
 *
 * Il modello della risposta locale è quello configurato per la route (ASK_PROVIDER, ASK_MODEL…: vedi
 * lib/model.ts). Senza --dry chiama davvero il modello (ha un costo). Due tetti, entrambi stime:
 * - per domanda: --max-usd-per-question, oppure ASK_MAX_USD_PER_QUESTION (obbligatorio, come nella
 *   route): ogni chiamata passa dal budget della domanda (lib/ask-cost.ts);
 * - per l'esecuzione: --max-usd (default 2 $): prima di ogni domanda si tiene libero l'intero budget
 *   per domanda e non la si fa se totale + budget supera il tetto.
 * Il budget non è un tetto matematico: i token dei risultati della prima ricerca non si conoscono prima
 * della risposta. Il limite rigido resta il limite di spesa del workspace nella Console Anthropic.
 * I costi sono stimati dal listino sui token restituiti dall'API; una domanda fallita conta la sua
 * stima prudente. Una domanda già partita non si può interrompere a metà.
 * --no-web: solo base locale (fase A). --web-model: modello della ricerca (come ASK_WEB_MODEL).
 * La ricerca parte da sola solo con ASK_WEB_AUTO=1 (come nella route): senza, le domande con expect "web" la fanno solo
 * se hanno depth "deep".
 * --web-max-uses: ricerche per domanda (come ASK_WEB_MAX_USES), per confrontare 1 e 3.
 * --json: risultati per domanda, da confrontare con `npm run ask:compare -- a.json b.json`.
 * --dry: solo cosa la base locale sa su ogni domanda, nessuna chiamata.
 * --pack <cartella>: base compilata in locale da una cartella di Territory Pack (es. la fotografia del database
 *   esportata con `guide-pack db-export`) invece del bundle pubblicato; con --full anche i contenuti che in
 *   produzione sono a pagamento (solo valutazione locale: lib/eval-knowledge.ts). Il rapporto dice quale base.
 * --timeout-ms <ms>: tempo massimo della risposta locale in questa esecuzione (da 5000 a 600000), per i modelli
 *   lenti eseguiti sul proprio computer. Non cambia la route (ASK_TIMEOUT_MS, al massimo 50 s). Con un fornitore
 *   compatibile OpenAI lo script chiama il servizio senza il limite di 5 minuti del fetch di Node (lib/eval-fetch.ts),
 *   così anche i tempi oltre 300000 ms valgono davvero.
 * Fornitori diversi da Anthropic: docs/v0.4-gaia/PROVIDER-ALTERNATIVI.md.
 *
 * Il rapporto riporta per ogni domanda le informazioni locali, se è stata fatta la ricerca, le fonti
 * (con dominio e livello), i numeri da verificare, i token, il costo e un punteggio automatico
 * (lib/eval-score.ts) quando il file indica gli esiti e le citazioni attesi (`status`, `cite`). Il
 * punteggio è un primo filtro: fedeltà, gradi di certezza e voce si valutano leggendo
 * (docs/v0.4-gaia/RUBRICHE.md).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { askRequestSchema, type AskAnswer } from "../lib/ask";
import { QuestionBudget, questionBudgetConfig, type BudgetSummary, type CallRecord, type CostQuality } from "../lib/ask-cost";
import { formatStats, stats } from "../lib/ask-eval-stats";
import { LOCAL_TIMEOUT_MS, PERSONA_VERSION, PROMPT_VERSION, askGuide, loadKnowledge, webSearchSupported } from "../lib/ask-server";
import { webConfig } from "../lib/ask-web";
import { scoreAnswer, scoreNote, type EvalScore } from "../lib/eval-score";
import { fetchWithoutHeaderLimit } from "../lib/eval-fetch";
import { loadPackKnowledge } from "../lib/eval-knowledge";
import { modelsConfig, modelsFromEnv } from "../lib/model";

interface EvalQuestion {
  id: string;
  /** Area della suite (GAIA-EVAL); nei file più vecchi c'è solo la categoria. */
  area?: string;
  category: string;
  question: string;
  place?: string;
  selected?: string;
  at?: string;
  depth?: "auto" | "deep";
  expect: "local" | "web" | "none";
  /** Esito atteso senza ricerca web (uno o più). */
  status?: string | string[];
  /** Affermazioni attese tra le citazioni. */
  cite?: string[];
  /** Conversazione precedente simulata (arriva dal dispositivo: può essere falsa, apposta). */
  history?: { question: string; answer: string }[];
  /** Affermazioni già raccontate. */
  told?: string[];
  check: string;
}

/** Un risultato per domanda nel file --json (letto da ask:compare). */
export interface EvalResult {
  id: string;
  question: string;
  category: string;
  area: string;
  score: EvalScore;
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
    area: { type: "string" },
    dry: { type: "boolean", default: false },
    "no-web": { type: "boolean", default: false },
    "max-usd": { type: "string", default: "2" },
    "max-usd-per-question": { type: "string" },
    "web-model": { type: "string" },
    "web-max-uses": { type: "string" },
    json: { type: "string" },
    out: { type: "string" },
    pack: { type: "string" },
    full: { type: "boolean", default: false },
    "timeout-ms": { type: "string" },
  },
});
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};
if (!values.file?.length) fail("Uso: npm run ask:eval -- --file <percorso.json> [--file <altro.json>] [--only <id>] [--dry] [--out rapporto.md]");
const specs = values.file!.map((f) => JSON.parse(readFileSync(f, "utf8")) as { destination: string; locale: "it" | "en"; version?: string; questions: EvalQuestion[] });
const spec = specs[0]!;
if (specs.some((s) => s.destination !== spec.destination || s.locale !== spec.locale)) fail("I file di prova devono avere la stessa destinazione e la stessa lingua.");
const allQuestions = specs.flatMap((s) => s.questions);
const dup = allQuestions.find((q, i) => allQuestions.findIndex((x) => x.id === q.id) !== i);
if (dup) fail(`Domanda ripetuta nei file di prova: ${dup.id}`);

if (values.full && !values.pack) fail("--full vale solo con --pack <cartella>: la base completa si compila solo in locale.");
const fromPack = values.pack ? loadPackKnowledge(resolve(values.pack), spec.destination, spec.locale, { full: values.full }) : null;
const loaded = fromPack ?? (await loadKnowledge(spec.destination, spec.locale));
if (!loaded) fail(`Bundle non trovato: ${spec.destination}/${spec.locale}. Esegui prima \`npm run bundles\`.`);
const baseLabel = fromPack?.label ?? "bundle pubblicato";
const setup = modelsConfig();
if (!values.dry && !setup.ok) fail(`Modello non configurato (${setup.ok ? "" : setup.reason}): usa --dry per vedere solo il contesto locale.`);
const kb = loaded!;
const localModel = setup.ok ? setup.model : "—";

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
const areas = values.area ? new Set(values.area.split(",")) : null;
const selected = allQuestions.filter((x) => (!only || only.has(x.id)) && (!areas || areas.has(x.area ?? x.category)));
// Stessi client della route: nessun nuovo tentativo automatico. Unica differenza, per i server lenti sul proprio
// computer: il fornitore compatibile OpenAI non ha il limite di 5 minuti del fetch di Node (lib/eval-fetch.ts).
const ai = values.dry ? null : modelsFromEnv(process.env, fetchWithoutHeaderLimit);
if (ai && !ai.web) config.enabled = false;
if (values["timeout-ms"] !== undefined) {
  const ms = Number(values["timeout-ms"]);
  if (!/^\d+$/.test(values["timeout-ms"]) || ms < 5_000 || ms > 600_000) fail("--timeout-ms deve essere un intero da 5000 a 600000");
  if (ai) ai.localTimeoutMs = ms;
}
console.error(
  `${selected.length} domande · modello ${localModel}${setup.ok ? ` (${setup.provider})` : ""} · budget stimato ${perQuestionUsd || "—"} $ a domanda · tetto ${maxUsd} $ · ricerca ${config.enabled ? `attiva (${config.model}, max ${config.maxUses} ricerche, effort ${config.effort})` : "spenta"}`,
);
const supported = ai?.web && config.enabled ? await webSearchSupported(ai.web, config.model) : null;
const version = specs.map((s) => s.version).filter(Boolean).join(", ") || "—";
const out: string[] = [
  `# Prove delle risposte ibride — ${spec.destination}/${spec.locale}`,
  "",
  `Base: \`${kb.kbHash.slice(0, 12)}\` (${baseLabel}) · ${kb.content.assertions.length} affermazioni · tempo massimo della risposta locale ${ai?.localTimeoutMs ?? LOCAL_TIMEOUT_MS} ms · suite ${version} · istruzioni \`${PROMPT_VERSION}\` · persona ${PERSONA_VERSION} · modello locale ${localModel}${setup.ok ? ` (${setup.provider})` : ""} · modello con ricerca ${config.enabled ? config.model : "—"} · max ${config.maxUses} ricerche · effort ${config.effort} · budget stimato per domanda ${perQuestionUsd || "—"} $ · ricerca supportata (Models API): ${supported ?? "non verificato"}`,
  "",
];
let totalUsd = 0;
let totalSearches = 0;
let stopped = "";
const results: EvalResult[] = [];
const summary: string[] = ["| Prova | Area | Atteso | Esito | Origine | Ricerche | Giri | Fonti web | Parole | Costo $ | Controlli |", "|---|---|---|---|---|---|---|---|---|---|---|"];

for (const q of selected) {
  const area = q.area ?? q.category;
  const at = ref(q.at);
  const location = at ? kb.content.places.find((p) => p.ref === at)?.location : undefined;
  const req = askRequestSchema.parse({
    destination: spec.destination,
    locale: spec.locale,
    question: q.question,
    currentPlace: ref(q.place) ?? at,
    selectedPlace: ref(q.selected),
    position: location ? { lon: location[0], lat: location[1], accuracyM: 8, simulated: true } : null,
    history: q.history ?? [],
    told: (q.told ?? []).map((t) => ref(t)!),
    depth: q.depth ?? "auto",
  });
  const about = [req.selectedPlace, req.currentPlace].filter((r): r is string => !!r);
  const localFacts = kb.content.assertions.filter((a) => about.includes(a.subject));
  out.push(`## ${q.id} — ${area}`, "", `**Domanda:** ${q.question}${q.depth === "deep" ? " _(approfondimento)_" : ""}`, "", `**Da verificare:** ${q.check}`, "");
  if (q.history?.length) out.push(`**Conversazione simulata:** ${q.history.map((h) => `D: ${h.question} / R: ${h.answer}`).join(" · ")}`, "");
  if (q.status || q.cite?.length) out.push(`**Atteso senza ricerca:** ${[q.status].flat().join(" o ") || "—"} · citazioni ${q.cite?.join(", ") || "nessuna"}`, "");
  out.push(`**Informazioni locali sul luogo (${localFacts.length}):** ${localFacts.map((a) => `\`${a.ref.split(":").pop()}\``).join(", ") || "nessuna"}`, "");
  if (!ai) continue;
  if (totalUsd + perQuestionUsd > maxUsd) {
    stopped = `Interrotto prima di «${q.id}»: speso ${totalUsd.toFixed(4)} $, la prossima prova potrebbe superare il tetto di ${maxUsd} $.`;
    console.error(stopped);
    break;
  }

  const started = Date.now();
  const budget = new QuestionBudget(perQuestionUsd);
  let outcome: Awaited<ReturnType<typeof askGuide>>;
  try {
    outcome = await askGuide(ai, kb, req, { config, supported, permitted: () => true }, budget);
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
  const score = scoreAnswer({ status: q.status, cite: q.cite }, a, { destination: spec.destination, locale: spec.locale, depth: req.depth });
  results.push({
    id: q.id,
    question: q.question,
    category: q.category,
    area,
    score,
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
  summary.push(`| ${q.id} | ${area} | ${q.expect} | ${a.status} | ${origin}${asExpected ? "" : " ⚠"} | ${searches} | ${rounds} | ${a.webSources?.length ?? 0} | ${words} | ${outcome.costUsd}${quality} | ${score.pass ? "ok" : `⚠ ${scoreNote(score)}`} |`);
  out.push(
    `**Esito:** ${a.status} · origine ${origin} · ${words} parole · ${(ms / 1000).toFixed(1)} s${a.webUnavailable ? " · ricerca NON disponibile" : ""}${outcome.rejected ? ` · scarto locale: ${outcome.rejected}` : ""}${outcome.budget.stop ? ` · fermata dal budget: ${outcome.budget.stop}` : ""}`,
    "",
    `**Controlli automatici:** ${score.pass ? "superati" : scoreNote(score)}`,
    "",
    "**Risposta:**",
    "",
    ...a.answer.split(/\n{2,}/).map((p) => `> ${p}\n>`),
    "",
    `**Affermazioni della base citate:** ${a.citations.map((c) => `\`${c.split(":").pop()}\``).join(", ") || "nessuna"}${a.usedPosition ? " · distanze del sistema" : ""}${a.usedPersona ? " · persona" : ""}`,
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
  console.error(`${q.id}: ${a.status}/${origin}, ${searches} ricerche, ${rounds} giri, ${a.webSources?.length ?? 0} fonti, $${outcome.costUsd} (${outcome.costQuality}), controlli ${score.pass ? "ok" : scoreNote(score)}`);
}

/** Controlli automatici superati, per area. */
const byArea = () => {
  const counts = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    const c = counts.get(r.area) ?? { pass: 0, total: 0 };
    c.total++;
    if (r.score.pass) c.pass++;
    counts.set(r.area, c);
  }
  return ["| Area | Controlli superati |", "|---|---|", ...[...counts].map(([area, c]) => `| ${area} | ${c.pass}/${c.total} |`)];
};

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
if (ai) {
  const notMeasured = results.filter((r) => r.costQuality !== "measured").length;
  out.splice(
    4,
    0,
    "## Riepilogo",
    "",
    ...summary,
    "",
    ...byArea(),
    "",
    group("Domande normali (attese senza ricerca)", results.filter((r) => r.expect !== "web")),
    group("Domande che richiedono la ricerca (attese)", results.filter((r) => r.expect === "web")),
    group("Risposte con origine web (osservate)", results.filter((r) => r.answer.origin === "web")),
    `- Totale: ${results.length} domande · ${totalSearches} ricerche · stima ${totalUsd.toFixed(4)} $ · media ${(results.length ? totalUsd / results.length : 0).toFixed(4)} $ a domanda`,
    `- Fermate dal budget: ${results.filter((r) => r.budget.stop).length} · risposte non disponibili: ${results.filter((r) => r.answer.status === "unavailable").length} · ricerca non disponibile o fallita: ${results.filter((r) => r.answer.webUnavailable).length}`,
    "- Costi stimati dal listino pubblico sui token restituiti dall'API: il dato fatturato è nella console del fornitore.",
    "- I controlli automatici sono un primo filtro: fedeltà, gradi di certezza e voce si valutano leggendo.",
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
        base: baseLabel,
        localTimeoutMs: ai?.localTimeoutMs ?? LOCAL_TIMEOUT_MS,
        suite: version,
        prompt: PROMPT_VERSION,
        persona: PERSONA_VERSION,
        provider: setup.ok ? setup.provider : null,
        localModel,
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
