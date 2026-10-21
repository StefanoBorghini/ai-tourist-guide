/**
 * Prove di qualità delle risposte ibride: esegue le domande di un file di prova (nel Territory Pack)
 * con lo stesso codice della route e scrive un rapporto da rileggere a mano.
 *
 *   npm run ask:eval -- --file <percorso.json> [--only <id,id>] [--area <area,area>] [--no-web]
 *                       [--web-model <id>] [--max-usd 2] [--max-calls N] [--dry] [--out rapporto.md]
 *                       [--json risultati.json]
 *
 * Il modello è quello configurato per la route (ASK_PROVIDER, ASK_MODEL…: vedi lib/model.ts).
 * Senza --dry chiama davvero il modello (ha un costo). Prima di ogni domanda tiene libera nel budget
 * una riserva prudente (reserveUsd) e non la fa se totale + riserva supera --max-usd (default 2 $).
 * I costi sono stimati dal listino sui token restituiti dall'API: il dato fatturato è nella console
 * del fornitore. Per i modelli senza listino in tabella il costo non è stimabile: serve --max-calls.
 * Una domanda già partita non si può interrompere a metà.
 * --no-web: solo base locale (fase A). --web-model: modello della ricerca (come ASK_WEB_MODEL).
 * --json: risultati per domanda, da confrontare con `npm run ask:compare -- a.json b.json`.
 * --dry: solo cosa la base locale sa su ogni domanda, nessuna chiamata.
 *
 * Il rapporto riporta per ogni domanda le informazioni locali, se è stata fatta la ricerca, le fonti,
 * i numeri da verificare, i token, il costo e un punteggio automatico (lib/eval-score.ts) quando il
 * file indica gli esiti e le citazioni attesi (`status`, `cite`). Il punteggio è un primo filtro:
 * fedeltà, gradi di certezza e voce si valutano leggendo (docs/v0.4-gaia/RUBRICHE.md).
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { AskAnswer } from "../lib/ask";
import { parseArgs } from "node:util";
import { askRequestSchema } from "../lib/ask";
import { PERSONA_VERSION, PROMPT_VERSION, askGuide, loadKnowledge, webSearchSupported } from "../lib/ask-server";
import { estimateUsd, reserveUsd, webConfig } from "../lib/ask-web";
import { scoreAnswer, scoreNote, type EvalScore } from "../lib/eval-score";
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

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    only: { type: "string" },
    area: { type: "string" },
    dry: { type: "boolean", default: false },
    "no-web": { type: "boolean", default: false },
    "max-usd": { type: "string", default: "2" },
    "max-calls": { type: "string" },
    "web-model": { type: "string" },
    json: { type: "string" },
    out: { type: "string" },
  },
});
if (!values.file) {
  console.error("Uso: npm run ask:eval -- --file <percorso.json> [--only <id>] [--area <area>] [--dry] [--out rapporto.md]");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(values.file, "utf8")) as { destination: string; locale: "it" | "en"; version?: string; questions: EvalQuestion[] };
const loaded = await loadKnowledge(spec.destination, spec.locale);
if (!loaded) {
  console.error(`Bundle non trovato: ${spec.destination}/${spec.locale}. Esegui prima \`npm run bundles\`.`);
  process.exit(1);
}
const setup = modelsConfig();
if (!values.dry && !setup.ok) {
  console.error(`Modello non configurato (${setup.reason}): usa --dry per vedere solo il contesto locale.`);
  process.exit(2);
}
const ai = values.dry ? null : modelsFromEnv();
const localModel = setup.ok ? setup.model : "—";

const ref = (slug?: string) => (slug ? (slug.includes(":") ? slug : `${spec.destination}:${slug}`) : null);
const config = {
  ...webConfig(),
  ...(values["web-model"] ? { model: values["web-model"] } : {}),
  ...(values["no-web"] || (ai && !ai.web) ? { enabled: false } : {}),
};
const maxUsd = Number(values["max-usd"]);
if (!(maxUsd > 0)) {
  console.error("--max-usd deve essere un numero positivo");
  process.exit(2);
}
const maxCalls = values["max-calls"] === undefined ? Infinity : Number(values["max-calls"]);
if (!(maxCalls > 0)) {
  console.error("--max-calls deve essere un numero positivo");
  process.exit(2);
}
// Senza listino il tetto in dollari non protegge: per quei modelli si chiede un tetto sulle chiamate.
const priced = estimateUsd(localModel, { input: 1, cacheWrite: 0, cacheRead: 0, output: 1, webSearches: 0 }) !== null;
if (ai && !priced && maxCalls === Infinity) {
  console.error(`Nessun listino per il modello ${localModel}: il tetto in dollari non si può applicare. Indica --max-calls N.`);
  process.exit(2);
}
const only = values.only ? new Set(values.only.split(",")) : null;
const areas = values.area ? new Set(values.area.split(",")) : null;
const selected = spec.questions.filter((x) => (!only || only.has(x.id)) && (!areas || areas.has(x.area ?? x.category)));
// Riserva per domanda: si applica a tutte, perché anche una domanda «locale» può finire in ricerca.
const reserve = reserveUsd(localModel, config);
console.error(
  `${selected.length} domande · modello ${localModel}${setup.ok ? ` (${setup.provider})` : ""} · riserva prudente ${reserve.toFixed(2)} $ a domanda (massimo ${(reserve * selected.length).toFixed(2)} $) · tetto ${maxUsd} $${maxCalls < Infinity ? ` · massimo ${maxCalls} domande` : ""} · ricerca ${config.enabled ? `attiva (${config.model})` : "spenta"}`,
);
const supported = ai?.web && config.enabled ? await webSearchSupported(ai.web, config.model) : null;
const out: string[] = [
  `# Prove delle risposte ibride — ${spec.destination}/${spec.locale}`,
  "",
  `Base: \`${loaded.kbHash.slice(0, 12)}\` · ${loaded.content.assertions.length} affermazioni · suite ${spec.version ?? "—"} · istruzioni \`${PROMPT_VERSION}\` · persona ${PERSONA_VERSION} · modello locale ${localModel}${setup.ok ? ` (${setup.provider})` : ""} · modello con ricerca ${config.enabled ? config.model : "—"} · max ${config.maxUses} ricerche · ricerca supportata (Models API): ${supported ?? "non verificato"}`,
  "",
];
let totalUsd = 0;
let totalSearches = 0;
let calls = 0;
const rows: { web: boolean; usd: number; input: number; cacheRead: number; cacheWrite: number; output: number }[] = [];
let stopped = "";
const results: { id: string; area: string; question: string; webModel: string | null; ms: number; answer: AskAnswer; score: EvalScore; error?: string }[] = [];
const summary: string[] = ["| Prova | Area | Atteso | Esito | Origine | Ricerche | Fonti web | Parole | Costo $ | Controlli |", "|---|---|---|---|---|---|---|---|---|---|"];

for (const q of selected) {
  const area = q.area ?? q.category;
  const at = ref(q.at);
  const location = at ? loaded.content.places.find((p) => p.ref === at)?.location : undefined;
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
  const localFacts = loaded.content.assertions.filter((a) => about.includes(a.subject));
  out.push(`## ${q.id} — ${area}`, "", `**Domanda:** ${q.question}${q.depth === "deep" ? " _(approfondimento)_" : ""}`, "", `**Da verificare:** ${q.check}`, "");
  if (q.history?.length) out.push(`**Conversazione simulata:** ${q.history.map((h) => `D: ${h.question} / R: ${h.answer}`).join(" · ")}`, "");
  if (q.status || q.cite?.length) out.push(`**Atteso senza ricerca:** ${[q.status].flat().join(" o ") || "—"} · citazioni ${q.cite?.join(", ") || "nessuna"}`, "");
  out.push(`**Informazioni locali sul luogo (${localFacts.length}):** ${localFacts.map((a) => `\`${a.ref.split(":").pop()}\``).join(", ") || "nessuna"}`, "");
  if (!ai) continue;
  if (totalUsd + reserve > maxUsd) {
    stopped = `Interrotto prima di «${q.id}»: speso ${totalUsd.toFixed(4)} $, la prossima prova potrebbe superare il tetto di ${maxUsd} $.`;
    console.error(stopped);
    break;
  }
  if (calls >= maxCalls) {
    stopped = `Interrotto prima di «${q.id}»: raggiunto il massimo di ${maxCalls} domande.`;
    console.error(stopped);
    break;
  }

  const started = Date.now();
  let outcome: Awaited<ReturnType<typeof askGuide>>;
  calls++;
  try {
    outcome = await askGuide(ai, loaded, req, { config, supported, permitted: () => true });
  } catch (error) {
    // Errore dell'API (credito esaurito, limite, rete): si registra e ci si ferma, senza riprovare.
    const message = (error as Error).message.slice(0, 300);
    stopped = `Interrotto a «${q.id}» per un errore dell'API: ${message}`;
    console.error(stopped);
    out.push(`**Errore:** ${message}`, "");
    break;
  }
  const a = outcome.answer;
  const score = scoreAnswer({ status: q.status, cite: q.cite }, a, { destination: spec.destination, locale: spec.locale, depth: req.depth });
  results.push({ id: q.id, area, question: q.question, webModel: outcome.usage.web ? (a.meter?.models.at(-1) ?? config.model) : null, ms: Date.now() - started, answer: a, score });
  const words = a.answer.split(/\s+/).filter(Boolean).length;
  const searches = outcome.usage.web?.webSearches ?? 0;
  const m = a.meter;
  if (m) rows.push({ web: outcome.usage.web !== undefined, usd: m.costUsd ?? 0, input: m.input, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, output: m.output });
  totalUsd += outcome.costUsd ?? 0;
  totalSearches += searches;
  const origin = a.origin ?? "local";
  const asExpected = q.expect === "none" ? searches === 0 : q.expect === origin;
  summary.push(`| ${q.id} | ${area} | ${q.expect} | ${a.status} | ${origin}${asExpected ? "" : " ⚠"} | ${searches} | ${a.webSources?.length ?? 0} | ${words} | ${outcome.costUsd ?? "?"} | ${score.pass ? "ok" : `⚠ ${scoreNote(score)}`} |`);
  out.push(
    `**Esito:** ${a.status} · origine ${origin} · ${words} parole · ${((Date.now() - started) / 1000).toFixed(1)} s${a.webUnavailable ? " · ricerca NON disponibile" : ""}${outcome.rejected ? ` · scarto locale: ${outcome.rejected}` : ""}`,
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
  out.push(`**Consumi:** modelli ${m?.models.join(", ") ?? "?"} · chiamate ${m?.calls ?? "?"} · locale ${JSON.stringify(outcome.usage.local ?? null)}${outcome.usage.web ? ` · ricerca ${JSON.stringify(outcome.usage.web)}` : ""} · stima $${outcome.costUsd ?? "?"}`, "");
  console.error(`${q.id}: ${a.status}/${origin}, ${searches} ricerche, ${a.webSources?.length ?? 0} fonti, $${outcome.costUsd ?? "?"}, controlli ${score.pass ? "ok" : scoreNote(score)}`);
}

const group = (web: boolean) => {
  const r = rows.filter((x) => x.web === web);
  if (r.length === 0) return `- ${web ? "Con" : "Senza"} ricerca web: nessuna domanda`;
  const sum = (k: keyof (typeof r)[number]) => r.reduce((a, x) => a + Number(x[k]), 0);
  const inputAll = sum("input") + sum("cacheRead") + sum("cacheWrite");
  return `- ${web ? "Con" : "Senza"} ricerca web: ${r.length} domande · media ${(sum("usd") / r.length).toFixed(4)} $ · token in ingresso medi ${Math.round(inputAll / r.length)} (letti dalla cache ${inputAll ? Math.round((100 * sum("cacheRead")) / inputAll) : 0}%) · in uscita medi ${Math.round(sum("output") / r.length)}`;
};
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
if (ai) {
  out.splice(
    4,
    0,
    "## Riepilogo",
    "",
    ...summary,
    "",
    ...byArea(),
    "",
    group(false),
    group(true),
    `- Totale: ${rows.length} domande · ${totalSearches} ricerche · stima ${priced ? `${totalUsd.toFixed(4)} $ · media ${(rows.length ? totalUsd / rows.length : 0).toFixed(4)} $ a domanda` : "non disponibile (modello senza listino)"}`,
    "- Costi stimati dal listino pubblico sui token restituiti dall'API: il dato fatturato è nella console del fornitore.",
    "- I controlli automatici sono un primo filtro: fedeltà, gradi di certezza e voce si valutano leggendo.",
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
        kbHash: loaded.kbHash,
        suite: spec.version ?? null,
        prompt: PROMPT_VERSION,
        persona: PERSONA_VERSION,
        provider: setup.ok ? setup.provider : null,
        localModel,
        webModel: config.enabled ? config.model : null,
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
