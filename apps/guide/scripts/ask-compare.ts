/**
 * Confronta due esecuzioni di `ask:eval --json` sulle stesse domande (es. ricerca con Opus e con Sonnet):
 * per ogni domanda esito, origine, fonti (con livello), ricerche, token, costo e le due risposte affiancate,
 * con lo spazio per il giudizio di qualità, che resta umano.
 *
 *   npm run ask:compare -- a.json b.json [--out confronto.md]
 *
 * Nessuna chiamata all'API, nessun costo.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { AskAnswer } from "../lib/ask";

interface Run {
  destination: string;
  kbHash: string;
  localModel: string;
  webModel: string | null;
  totalUsd: number;
  stopped: string | null;
  results: { id: string; question: string; webModel: string | null; ms: number; answer: AskAnswer }[];
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string" } } });
if (positionals.length !== 2) {
  console.error("Uso: npm run ask:compare -- a.json b.json [--out confronto.md]");
  process.exit(2);
}
const [a, b] = positionals.map((p) => JSON.parse(readFileSync(p, "utf8")) as Run) as [Run, Run];
const name = (r: Run) => `ricerca ${r.webModel ?? "spenta"}`;
const lines: string[] = [`# Confronto — ${name(a)} / ${name(b)}`, ""];
if (a.kbHash !== b.kbHash) lines.push("⚠ Le due esecuzioni usano versioni diverse della base di conoscenza: il confronto non è omogeneo.", "");

const fmt = (x: AskAnswer | undefined) => {
  if (!x) return { esito: "—", fonti: "—", ricerche: "—", token: "—", costo: "—", parole: "—" };
  const m = x.meter;
  const tiers = (x.webSources ?? []).map((s) => s.tier).sort();
  return {
    esito: `${x.status} · ${x.origin ?? "local"}${x.webUnavailable ? " · ricerca non disponibile" : ""}`,
    fonti: `${x.webSources?.length ?? 0} web${tiers.length ? ` (livelli ${tiers.join(",")})` : ""} · ${x.citations.length} della guida`,
    ricerche: String(m?.webSearches ?? x.webSearches ?? 0),
    token: m ? `${m.input + m.cacheRead + m.cacheWrite} in (cache letti ${m.cacheRead}) · ${m.output} out` : "—",
    costo: m?.costUsd == null ? "?" : `${m.costUsd.toFixed(4)} $`,
    parole: String(x.answer.split(/\s+/).filter(Boolean).length),
  };
};
const sum = (r: Run, f: (x: AskAnswer) => number) => r.results.reduce((t, x) => t + f(x.answer), 0);

lines.push("## Riepilogo", "", `| | ${name(a)} | ${name(b)} |`, "|---|---|---|");
for (const [label, f] of [
  ["Domande", (r: Run) => String(r.results.length)],
  ["Con ricerca", (r: Run) => String(r.results.filter((x) => x.answer.origin === "web").length)],
  ["Ricerche totali", (r: Run) => String(sum(r, (x) => x.meter?.webSearches ?? 0))],
  ["Fonti web citate (media)", (r: Run) => (sum(r, (x) => x.webSources?.length ?? 0) / Math.max(1, r.results.length)).toFixed(1)],
  ["Fonti di livello 1–3 (istituzioni, archivi, università)", (r: Run) => String(sum(r, (x) => (x.webSources ?? []).filter((s) => s.tier <= 3).length))],
  ["Numeri da verificare (totale)", (r: Run) => String(sum(r, (x) => x.unsupportedNumbers?.length ?? 0))],
  ["Costo stimato totale", (r: Run) => `${r.totalUsd.toFixed(4)} $`],
  ["Costo medio a domanda", (r: Run) => `${(r.totalUsd / Math.max(1, r.results.length)).toFixed(4)} $`],
  ["Tempo medio", (r: Run) => `${(r.results.reduce((t, x) => t + x.ms, 0) / Math.max(1, r.results.length) / 1000).toFixed(1)} s`],
  ["Interrotta", (r: Run) => r.stopped ?? "no"],
] as [string, (r: Run) => string][]) lines.push(`| ${label} | ${f(a)} | ${f(b)} |`);
lines.push("");

for (const id of [...new Set([...a.results, ...b.results].map((x) => x.id))]) {
  const ra = a.results.find((x) => x.id === id);
  const rb = b.results.find((x) => x.id === id);
  const fa = fmt(ra?.answer);
  const fb = fmt(rb?.answer);
  lines.push(`## ${id}`, "", `**Domanda:** ${(ra ?? rb)!.question}`, "", `| | ${name(a)} | ${name(b)} |`, "|---|---|---|");
  for (const k of ["esito", "fonti", "ricerche", "token", "costo", "parole"] as const) lines.push(`| ${k} | ${fa[k]} | ${fb[k]} |`);
  lines.push("| qualità (1–5, da compilare) | | |", "| affermazioni non supportate (da compilare) | | |", "");
  for (const [r, label] of [[ra, name(a)], [rb, name(b)]] as const) {
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
const md = lines.join("\n");
if (values.out) writeFileSync(values.out, md);
else console.log(md);
