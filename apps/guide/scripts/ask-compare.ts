/**
 * Confronta due esecuzioni di `ask:eval --json` sulle stesse domande (es. ASK_WEB_MAX_USES 1 e 3, o due
 * modelli): costi (mediana, 90° percentile, massimo) per domande normali e con ricerca, ricerche, giri,
 * token, tempi, errori e ripieghi, e le due risposte affiancate. Il giudizio di qualità resta umano.
 *
 *   npm run ask:compare -- a.json b.json [--out confronto.md]
 *   npm run ask:compare -- a.json b.json --blind --key chiave.json --scores-template punteggi.json [--out cieca.md]
 *   npm run ask:compare -- a.json b.json --key chiave.json --scores punteggi.json [--out confronto.md]
 *
 * --blind: le risposte compaiono come X e Y in ordine casuale per domanda, senza costi né configurazione;
 * la chiave (chi è X) va in --key e non si guarda prima di aver compilato i punteggi (--scores-template
 * crea il modulo vuoto con la rubrica). Con --key e --scores il confronto riporta i punteggi a ciascuna
 * esecuzione. Nessuna chiamata all'API, nessun costo.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { AskAnswer } from "../lib/ask";
import { RUBRIC, aggregateScores, blindKey, emptyScore, formatStats, stats, type BlindKey, type Score, type ScoreAggregate } from "../lib/ask-eval-stats";

interface Result {
  id: string;
  question: string;
  category?: string;
  expect?: "local" | "web" | "none";
  webModel: string | null;
  ms: number;
  answer: AskAnswer;
  costUsd?: number;
  costQuality?: string;
  searches?: number;
  rounds?: number;
  error?: string;
  budget?: { stop?: string };
}
interface Run {
  destination: string;
  kbHash: string;
  localModel: string;
  webModel: string | null;
  webMaxUses?: number | null;
  webEffort?: string | null;
  maxUsdPerQuestion?: number;
  totalUsd: number;
  stopped: string | null;
  results: Result[];
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    blind: { type: "boolean", default: false },
    key: { type: "string" },
    scores: { type: "string" },
    "scores-template": { type: "string" },
  },
});
if (positionals.length !== 2 || (values.blind && !values.key) || (values.scores && !values.key)) {
  console.error("Uso: npm run ask:compare -- a.json b.json [--out confronto.md] [--blind --key chiave.json [--scores-template punteggi.json]] [--key chiave.json --scores punteggi.json]");
  process.exit(2);
}
const [a, b] = positionals.map((p) => JSON.parse(readFileSync(p, "utf8")) as Run) as [Run, Run];
const name = (r: Run) => `ricerca ${r.webModel ?? "spenta"}${r.webMaxUses ? ` · max ${r.webMaxUses} ricerche` : ""}${r.webEffort ? ` · effort ${r.webEffort}` : ""}`;
const ids = [...new Set([...a.results, ...b.results].map((x) => x.id))];
const find = (r: Run, id: string) => r.results.find((x) => x.id === id);
const lines: string[] = [];
const write = () => {
  const md = lines.join("\n");
  if (values.out) writeFileSync(values.out, md);
  else console.log(md);
};

// ------------------------------------------------------------------ alla cieca

if (values.blind) {
  if (existsSync(values.key!)) {
    console.error(`${values.key} esiste già: non la sovrascrivo (servirebbe a sciogliere la valutazione precedente).`);
    process.exit(2);
  }
  const key: BlindKey = blindKey(ids);
  writeFileSync(values.key!, JSON.stringify({ a: name(a), b: name(b), key }, null, 2));
  if (values["scores-template"]) {
    writeFileSync(values["scores-template"], JSON.stringify({ rubrica: RUBRIC, punteggi: Object.fromEntries(ids.map((id) => [id, { X: emptyScore(), Y: emptyScore() }])) }, null, 2));
  }
  lines.push(
    "# Valutazione alla cieca",
    "",
    "Per ogni domanda due risposte, X e Y, in ordine casuale. Non aprire la chiave prima di aver finito.",
    "Lunghezza e numero di fonti non sono criteri: conta ciò che è corretto e supportato dalle fonti.",
    "",
    "## Rubrica",
    "",
    ...Object.entries(RUBRIC).map(([k, v]) => `- **${k}**: ${v}`),
    "",
  );
  for (const id of ids) {
    const k = key[id]!;
    const q = (find(a, id) ?? find(b, id))!;
    lines.push(`## ${id}`, "", `**Domanda:** ${q.question}`, "");
    for (const label of ["X", "Y"] as const) {
      const r = find(k[label] === "a" ? a : b, id);
      lines.push(`**Risposta ${label}:**`, "");
      if (!r) {
        lines.push("_non eseguita_", "");
        continue;
      }
      lines.push(...r.answer.answer.split(/\n{2,}/).map((p) => `> ${p}\n>`), "");
      for (const s of r.answer.webSources ?? []) lines.push(`- [${s.title}](${s.url}) — ${s.site}${s.citedText ? `\n  «${s.citedText}»` : ""}`);
      if (r.answer.citations.length) lines.push(`- Affermazioni della guida: ${r.answer.citations.map((c) => `\`${c.split(":").pop()}\``).join(", ")}`);
      lines.push("");
    }
  }
  write();
  process.exit(0);
}

// ------------------------------------------------------------------ confronto

lines.push(`# Confronto — A: ${name(a)} / B: ${name(b)}`, "");
if (a.kbHash !== b.kbHash) lines.push("⚠ Le due esecuzioni usano versioni diverse della base di conoscenza: il confronto non è omogeneo.", "");
lines.push("Costi stimati dal listino sui consumi restituiti dall'API (non fatturato). Con meno di 10 campioni i percentili sono solo indicativi.", "");

const cost = (x: Result) => x.costUsd ?? x.answer.meter?.costUsd ?? 0;
const searches = (x: Result) => x.searches ?? x.answer.meter?.webSearches ?? 0;
const sum = (r: Run, f: (x: Result) => number) => r.results.reduce((t, x) => t + f(x), 0);
const normal = (r: Run) => r.results.filter((x) => (x.expect ? x.expect !== "web" : x.answer.origin !== "web"));
const needsWeb = (r: Run) => r.results.filter((x) => (x.expect ? x.expect === "web" : x.answer.origin === "web"));

lines.push("## Riepilogo", "", "| | A | B |", "|---|---|---|");
for (const [label, f] of [
  ["Domande", (r: Run) => String(r.results.length)],
  ["Con origine web", (r: Run) => String(r.results.filter((x) => x.answer.origin === "web").length)],
  ["Ricerche totali", (r: Run) => String(sum(r, searches))],
  ["Giri (pause_turn compresi)", (r: Run) => String(sum(r, (x) => x.rounds ?? 0))],
  ["Costo $ — domande normali", (r: Run) => formatStats(stats(normal(r).map(cost)))],
  ["Costo $ — domande che richiedono la ricerca", (r: Run) => formatStats(stats(needsWeb(r).map(cost)))],
  ["Costo stimato totale", (r: Run) => `${r.totalUsd.toFixed(4)} $`],
  ["Costi non misurati (stimati / fuori listino)", (r: Run) => String(r.results.filter((x) => x.costQuality && x.costQuality !== "measured").length)],
  ["Tempo s", (r: Run) => formatStats(stats(r.results.map((x) => x.ms / 1000)), 1)],
  ["Fonti web citate (media)", (r: Run) => (sum(r, (x) => x.answer.webSources?.length ?? 0) / Math.max(1, r.results.length)).toFixed(1)],
  ["Fonti di livello 1–3 (istituzioni, archivi, università)", (r: Run) => String(sum(r, (x) => (x.answer.webSources ?? []).filter((s) => s.tier <= 3).length))],
  ["Numeri da verificare (totale)", (r: Run) => String(sum(r, (x) => x.answer.unsupportedNumbers?.length ?? 0))],
  ["Ricerca non disponibile o fallita (ripiego sulla base)", (r: Run) => String(r.results.filter((x) => x.answer.webUnavailable).length)],
  ["Fermate dal budget", (r: Run) => String(r.results.filter((x) => x.budget?.stop).length)],
  ["Non disponibili", (r: Run) => String(r.results.filter((x) => x.answer.status === "unavailable").length)],
  ["Interrotta", (r: Run) => r.stopped ?? "no"],
] as [string, (r: Run) => string][]) lines.push(`| ${label} | ${f(a)} | ${f(b)} |`);
const sa = sum(a, searches);
const sb = sum(b, searches);
lines.push("", `Ricerche: A ${sa}, B ${sb}${sa && sb ? ` (A/B = ${(sa / sb).toFixed(2)})` : ""}. Costo totale: A ${a.totalUsd.toFixed(4)} $, B ${b.totalUsd.toFixed(4)} $.`, "");

if (values.key && values.scores) {
  const keyFile = JSON.parse(readFileSync(values.key, "utf8")) as { key: BlindKey };
  const scoreFile = JSON.parse(readFileSync(values.scores, "utf8")) as { punteggi: Record<string, { X: Score; Y: Score }> };
  const agg = aggregateScores(keyFile.key, scoreFile.punteggi);
  const row = (s: ScoreAggregate) =>
    `${s.valutate} valutate · corrette ${s.corrette === null ? "—" : `${Math.round(s.corrette * 100)}%`} · medie: corretta ${s.medie.corretta ?? "—"}, completezza ${s.medie.completezza ?? "—"}, pertinenza ${s.medie.pertinenza ?? "—"}, fonti ${s.medie.fonti ?? "—"} · fuorvianti ${s.fuorvianti}`;
  lines.push("## Qualità (valutazione alla cieca, sciolta con la chiave)", "", `- A: ${row(agg.a)}`, `- B: ${row(agg.b)}`, "");
  // Per categoria: dove una configurazione perde rispetto all'altra.
  const cats = [...new Set([...a.results, ...b.results].map((x) => x.category ?? "—"))];
  lines.push("| Categoria | A corrette | B corrette |", "|---|---|---|");
  for (const cat of cats) {
    const inCat = Object.fromEntries(Object.entries(scoreFile.punteggi).filter(([id]) => ((find(a, id) ?? find(b, id))?.category ?? "—") === cat));
    const c = aggregateScores(keyFile.key, inCat);
    const pct = (s: ScoreAggregate) => (s.corrette === null ? "—" : `${Math.round(s.corrette * 100)}% di ${s.valutate}`);
    lines.push(`| ${cat} | ${pct(c.a)} | ${pct(c.b)} |`);
  }
  lines.push("");
}

const fmt = (x: Result | undefined) => {
  if (!x) return { esito: "—", fonti: "—", ricerche: "—", giri: "—", token: "—", costo: "—", tempo: "—", parole: "—" };
  const m = x.answer.meter;
  const tiers = (x.answer.webSources ?? []).map((s) => s.tier).sort();
  return {
    esito: `${x.answer.status} · ${x.answer.origin ?? "local"}${x.answer.webUnavailable ? " · ricerca non disponibile" : ""}${x.budget?.stop ? " · fermata dal budget" : ""}`,
    fonti: `${x.answer.webSources?.length ?? 0} web${tiers.length ? ` (livelli ${tiers.join(",")})` : ""} · ${x.answer.citations.length} della guida`,
    ricerche: String(searches(x)),
    giri: String(x.rounds ?? "—"),
    token: m ? `${m.input + m.cacheRead + m.cacheWrite} in (cache letti ${m.cacheRead}) · ${m.output} out` : "—",
    costo: `${cost(x).toFixed(4)} $${x.costQuality && x.costQuality !== "measured" ? ` (${x.costQuality})` : ""}`,
    tempo: `${(x.ms / 1000).toFixed(1)} s`,
    parole: String(x.answer.answer.split(/\s+/).filter(Boolean).length),
  };
};

for (const id of ids) {
  const ra = find(a, id);
  const rb = find(b, id);
  const fa = fmt(ra);
  const fb = fmt(rb);
  const q = (ra ?? rb)!;
  lines.push(`## ${id}${q.category ? ` — ${q.category}` : ""}`, "", `**Domanda:** ${q.question}`, "", "| | A | B |", "|---|---|---|");
  for (const k of ["esito", "fonti", "ricerche", "giri", "token", "costo", "tempo", "parole"] as const) lines.push(`| ${k} | ${fa[k]} | ${fb[k]} |`);
  lines.push("");
  for (const [r, label] of [[ra, "A"], [rb, "B"]] as const) {
    lines.push(`**${label}:**`, "");
    if (!r) {
      lines.push("_non eseguita_", "");
      continue;
    }
    lines.push(...r.answer.answer.split(/\n{2,}/).map((p) => `> ${p}\n>`), "");
    for (const s of r.answer.webSources ?? []) lines.push(`- [${s.title}](${s.url}) — ${s.site} · livello ${s.tier}${s.pageAge ? ` · ${s.pageAge}` : ""}`);
    lines.push("");
  }
}
write();
