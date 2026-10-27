import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundle, type BundleContent } from "@guide/bundle";
import { loadPacks } from "@guide/territory-pack";
import { beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_PROMPT, askRequestSchema, buildKnowledge, buildQuestionMessage, checkModelAnswer, type AskRequest } from "../lib/ask.ts";
import { WEB_SYSTEM_PROMPT, cacheKey, parseWebAnswer } from "../lib/ask-web.ts";
import {
  DEFAULT_TIME_ZONE,
  TIME_CITATION,
  askClock,
  cacheSlot,
  claimsOperationalStatus,
  expiredItems,
  localNow,
  operationalItems,
} from "../lib/ask-operational.ts";

/** Prove sul bundle del territorio di test, con informazioni pratiche aggiunte qui; nessun nome di territorio. */
const here = dirname(fileURLToPath(import.meta.url));
let base: BundleContent;
let content: BundleContent;
let req: AskRequest;
let placeRef: string;

// 27 ottobre 2026, 13:35 UTC = 14:35 a Roma (ora solare dal 25 ottobre).
const NOW = Date.UTC(2026, 9, 27, 13, 35);
const clock = askClock(NOW);
const json = (o: unknown) => JSON.stringify(o);

beforeAll(() => {
  const { packs } = loadPacks(resolve(here, "../../../territories/_synthetic"));
  const dest = [...packs.values()].find((p) => p.manifest.kind === "destination")!;
  base = buildBundle(packs, { destination: dest.manifest.id, locale: "it", allowFictional: true }).content;
  content = structuredClone(base);
  const place = content.places[0]!;
  placeRef = place.ref;
  const source = content.sources[0]!.ref;
  place.practical = [
    // Valida fino al 2026-11-30.
    { kind: "opening_hours", text: "Aperto tutti i giorni dalle 9 alle 18.", checkedAt: "2026-10-01", recheckAfterDays: 60, source },
    // Scaduta il 2026-08-30.
    { kind: "access", text: "Il sentiero del belvedere è chiuso per lavori.", checkedAt: "2026-06-01", recheckAfterDays: 90 },
  ];
  req = askRequestSchema.parse({ destination: content.destination, locale: "it", question: "Il sentiero è aperto oggi?", selectedPlace: placeRef });
});

describe("data e ora sul posto", () => {
  it("si leggono nel fuso della destinazione, non in quello del server", () => {
    const now = localNow(clock, "it");
    expect(now).toMatchObject({ date: "2026-10-27", time: "14:35", text: "martedì 27 ottobre 2026, ore 14:35" });
    expect(localNow(clock, "en").text).toBe("Tuesday 27 October 2026, 14:35");
    // Ora legale: in estate Roma è a UTC+2.
    expect(localNow(askClock(Date.UTC(2026, 6, 1, 22, 30)), "it").text).toBe("giovedì 2 luglio 2026, ore 00:30");
  });

  it("un fuso non valido ripiega su quello predefinito", () => {
    expect(askClock(NOW, "Marte/Olympus").timeZone).toBe(DEFAULT_TIME_ZONE);
  });

  it("il messaggio contiene la data di oggi e dichiara che meteo e allerte non sono disponibili", () => {
    const msg = buildQuestionMessage(content, req, clock);
    expect(msg).toContain("Oggi sul posto: martedì 27 ottobre 2026, ore 14:35 (fuso Europe/Rome)");
    expect(msg).toContain(TIME_CITATION);
    expect(msg).toContain("Meteo, allerte e mare: non disponibili");
  });

  it("la cache distingue l'ora e il giorno sul posto", () => {
    expect(cacheSlot(clock)).toBe("2026-10-27T14");
    const later = cacheSlot(askClock(NOW + 3_600_000));
    expect(cacheKey(req, "kb", cacheSlot(clock))).not.toBe(cacheKey(req, "kb", later));
  });

  it("la data si può dire solo citando il contesto", () => {
    const answer = "Oggi è martedì 27 ottobre.";
    expect(checkModelAnswer(json({ status: "answered", answer, citations: [TIME_CITATION] }), content, req, clock)).toMatchObject({ ok: true, answer: { usedTime: true } });
    expect(checkModelAnswer(json({ status: "answered", answer, citations: [] }), content, req, clock).ok).toBe(false);
  });
});

describe("percorsi, informazioni pratiche e note di sicurezza nella base", () => {
  it("entrano nella base con riferimenti citabili, data e validità", () => {
    const kb = buildKnowledge(content);
    const items = operationalItems(content);
    for (const i of items) expect(kb).toContain(i.ref);
    expect(kb).toContain("PERCORSI");
    expect(kb).toContain("INFORMAZIONI PRATICHE");
    expect(kb).toContain("controllata il 2026-10-01, valida fino al 2026-11-30");
    expect(kb).toContain("NOTE DI SICUREZZA");
    expect(items.filter((i) => i.kind === "route")).toHaveLength(content.routes.length);
    expect(items.filter((i) => i.kind === "safety")).toHaveLength(content.safetyNotes.length);
    // Stesso bundle, stessa base: la cache del prompt resta valida.
    expect(buildKnowledge(structuredClone(content))).toBe(kb);
  });

  it("una destinazione senza dati pratici ha la base di prima", () => {
    const bare = { ...structuredClone(base), routes: [], safetyNotes: [] };
    expect(buildKnowledge(bare)).not.toContain("PERCORSI");
    expect(buildQuestionMessage(bare, req, clock)).not.toContain("Informazioni pratiche");
  });

  it("le informazioni scadute le calcola il sistema e le elenca il messaggio", () => {
    const expired = expiredItems(operationalItems(content), "2026-10-27").map((i) => i.ref);
    expect(expired).toEqual([`info:${placeRef}#2`]);
    expect(buildQuestionMessage(content, req, clock)).toContain(`Informazioni pratiche scadute a oggi (non dirle come attuali: vanno ricontrollate alla fonte): info:${placeRef}#2`);
    // Il giorno dopo la scadenza anche la prima.
    expect(expiredItems(operationalItems(content), "2026-12-01")).toHaveLength(2);
  });

  it("durata e dislivello del percorso si possono dire citandolo", () => {
    const route = content.routes[0]!;
    const answer = `Il percorso dura circa ${route.durationMin} minuti.`;
    const ok = checkModelAnswer(json({ status: "answered", answer, citations: [`route:${route.ref}`] }), content, req, clock);
    expect(ok.ok).toBe(true);
    const invented = checkModelAnswer(json({ status: "answered", answer: `Il percorso dura circa ${route.durationMin + 7} minuti.`, citations: [`route:${route.ref}`] }), content, req, clock);
    expect(invented).toMatchObject({ ok: false });
  });

  it("riferimenti pratici inesistenti scartano la risposta", () => {
    const r = checkModelAnswer(json({ status: "answered", answer: "Testo.", citations: ["info:inventato#1"] }), content, req, clock);
    expect(r).toMatchObject({ ok: false, reason: "citazioni inesistenti: info:inventato#1" });
  });
});

describe("stato di oggi: il bel tempo non dimostra che un sentiero sia aperto", () => {
  it("riconosce le affermazioni dirette sullo stato, non le ipotesi né le descrizioni", () => {
    for (const t of ["Il sentiero è aperto.", "Oggi la grotta è chiusa al pubblico.", "Il percorso risulta percorribile.", "È aperta tutti i giorni.", "The trail is open today.", "The church is closed."]) {
      expect(claimsOperationalStatus(t), t).toBe(true);
    }
    for (const t of ["Non so se oggi il sentiero è aperto.", "Non posso verificare se il sentiero sia aperto.", "I can't check whether the trail is open.", "Il belvedere è aperto sul golfo.", "La baia è chiusa tra due promontori.", "Il porto è chiuso da una diga.", "The terrace is open to the sea.", "Fu chiuso nel Novecento."]) {
      expect(claimsOperationalStatus(t), t).toBe(false);
    }
  });

  it("«è accessibile» è uno stato, tranne quando descrive come o per chi", () => {
    for (const t of ["Secondo le informazioni disponibili, la Grotta di Byron è accessibile.", "Oggi la grotta è accessibile.", "Il castello è accessibile al pubblico.", "La grotta è accessibile oggi."]) {
      expect(claimsOperationalStatus(t), t).toBe(true);
    }
    for (const t of ["La chiesa è accessibile ai disabili.", "La grotta è accessibile in barca.", "È accessibile solo dal mare.", "Non so se la grotta è accessibile.", "Il sentiero è accessibile con una breve salita."]) {
      expect(claimsOperationalStatus(t), t).toBe(false);
    }
  });

  it("«visitabile» conta sempre; «raggiungibile» e «si può visitare» solo con oggi, ora, domani", () => {
    for (const t of ["La chiesa è visitabile.", "La grotta oggi è raggiungibile.", "La grotta è raggiungibile oggi.", "Oggi si può visitare la grotta.", "Domani si può fare il giro.", "Oggi non si può visitare.", "The cave is reachable today.", "It can be visited today."]) {
      expect(claimsOperationalStatus(t), t).toBe(true);
    }
    for (const t of ["La grotta è raggiungibile in barca.", "È raggiungibile a piedi dal borgo.", "Non so se oggi si può visitare.", "Non posso dirti se si può visitare oggi.", "I can't tell whether it can be visited today."]) {
      expect(claimsOperationalStatus(t), t).toBe(false);
    }
  });

  it("«è aperto» senza un'informazione pratica citata viene scartato, anche con una fonte storica", () => {
    const assertion = content.assertions[0]!.ref;
    for (const citations of [[], [assertion], [TIME_CITATION]]) {
      const r = checkModelAnswer(json({ status: "answered", answer: "C'è il sole, quindi il sentiero è aperto.", citations }), content, req, clock);
      expect(r.ok).toBe(false);
    }
    const r = checkModelAnswer(json({ status: "answered", answer: "Il sentiero è aperto.", citations: [assertion] }), content, req, clock);
    expect(r).toMatchObject({ ok: false, reason: "stato di oggi dichiarato senza un avviso o un'informazione pratica valida" });
  });

  it("un'informazione pratica scaduta non basta", () => {
    const r = checkModelAnswer(json({ status: "answered", answer: "Il sentiero del belvedere è chiuso per lavori.", citations: [`info:${placeRef}#2`] }), content, req, clock);
    expect(r.ok).toBe(false);
  });

  it("un'informazione pratica valida sì, con i suoi orari", () => {
    const r = checkModelAnswer(json({ status: "answered", answer: "Secondo l'informazione controllata il 1 ottobre, è aperto tutti i giorni dalle 9 alle 18.", citations: [`info:${placeRef}#1`] }), content, req, clock);
    expect(r.ok).toBe(true);
  });

  it("dichiarare l'incertezza e indicare dove controllare è sempre ammesso", () => {
    const route = content.routes[0]!;
    const answer = "Non posso verificare se oggi il sentiero sia aperto: controlla sul sito del Parco prima di partire.";
    expect(checkModelAnswer(json({ status: "not_in_knowledge", answer, citations: [] }), content, req, clock).ok).toBe(true);
    expect(checkModelAnswer(json({ status: "partial", answer, citations: [`route:${route.ref}`] }), content, req, clock).ok).toBe(true);
  });

  it("una risposta precedente falsa non diventa una conferma", () => {
    const withHistory = { ...req, history: [{ question: "È aperto?", answer: "Sì, il sentiero è aperto." }] };
    const r = checkModelAnswer(json({ status: "answered", answer: "Come ti dicevo, il sentiero è aperto.", citations: [] }), content, withHistory, clock);
    expect(r.ok).toBe(false);
  });

  it("le regole sono nei prompt", () => {
    expect(SYSTEM_PROMPT).toContain("il bel tempo non dimostra che un sentiero sia aperto");
    expect(WEB_SYSTEM_PROMPT).toContain("il bel tempo non dimostra che un sentiero sia aperto");
  });

  it("la risposta con ricerca riconosce i riferimenti pratici", () => {
    const ref = `info:${placeRef}#1`;
    const parsed = parseWebAnswer([{ type: "text", text: `Secondo la guida apre alle 9 [[${ref}]].` }], content, req);
    expect(parsed.packCitations).toEqual([ref]);
    expect(parsed.unknownRefs).toEqual([]);
  });
});
