import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundle, type BundleContent } from "@guide/bundle";
import { loadPacks } from "@guide/territory-pack";
import { beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../lib/ask.ts";
import { checkExample, evalRequest, toTrainingRecord, type EvalCase, type Example } from "../lib/gaia-examples.ts";

/** Esempi di riferimento sul territorio di test, senza nomi di territorio scritti qui. */
const here = dirname(fileURLToPath(import.meta.url));
let content: BundleContent;
let place: string;
let fact: { slug: string; text: string };

beforeAll(() => {
  const { packs } = loadPacks(resolve(here, "../../../territories/_synthetic"));
  const dest = [...packs.values()].find((p) => p.manifest.kind === "destination")!;
  content = buildBundle(packs, { destination: dest.manifest.id, locale: "it", allowFictional: true }).content;
  const a = content.assertions.find((x) => !x.value && !/\d/.test(x.text) && content.places.some((p) => p.ref === x.subject))!;
  place = a.subject.split(":").pop()!;
  fact = { slug: a.ref.split(":").pop()!, text: a.text };
});

const example = (o: Partial<Example> = {}): Example => ({ id: "e1", status: "answered", answer: fact.text, citations: [fact.slug], approved: false, ...o });
const evalCase = (o: Partial<EvalCase> = {}): EvalCase => ({ id: "e1", question: "Cos'è?", selected: place, status: "answered", cite: [fact.slug], ...o });

describe("esempi di riferimento", () => {
  it("accetta un esempio fedele alla base, con citazioni brevi", () => {
    expect(checkExample(content, "it", evalCase(), example())).toMatchObject({ ok: true, problems: [] });
  });

  it("scarta un esempio con un numero inventato, come la produzione", () => {
    const r = checkExample(content, "it", evalCase(), example({ answer: `${fact.text} Risale al 1312.` }));
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain("1312");
  });

  it("scarta un esito diverso da quello atteso e le citazioni attese mancanti", () => {
    expect(checkExample(content, "it", evalCase(), example({ status: "partial" })).problems.join()).toContain("esito inatteso");
    expect(checkExample(content, "it", evalCase({ cite: [fact.slug, "persona:gaia"] }), example()).problems.join()).toContain("persona:gaia");
  });

  it("scarta parole vietate dalla persona e il markdown", () => {
    expect(checkExample(content, "it", evalCase(), example({ answer: `${fact.text} Davvero mozzafiato.` })).ok).toBe(false);
    expect(checkExample(content, "it", evalCase(), example({ answer: `- ${fact.text}` })).ok).toBe(false);
  });

  it("un'emergenza va al 112 senza citazioni", () => {
    const q = evalCase({ status: "safety", cite: [] });
    expect(checkExample(content, "it", q, example({ status: "safety", answer: "Chiama subito il 112.", citations: [] })).ok).toBe(true);
    expect(checkExample(content, "it", q, example({ status: "safety", answer: "Chiama subito i soccorsi.", citations: [] })).ok).toBe(false);
  });

  it("produce il record di allenamento con lo stesso prompt della produzione e la risposta in JSON", () => {
    const q = evalCase();
    const record = toTrainingRecord(content, "it", q, example());
    expect(record.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(record.messages[0]!.content.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(record.messages[1]!.content).toContain(evalRequest(content, "it", q).question);
    expect(JSON.parse(record.messages[2]!.content)).toEqual({ status: "answered", answer: fact.text, citations: [`${content.destination}:${fact.slug}`] });
  });
});
