import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundle, type BundleContent } from "@guide/bundle";
import { loadPacks } from "@guide/territory-pack";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SYSTEM_PROMPT, askRequestSchema, buildKnowledge, buildQuestionMessage, checkModelAnswer, extractTextRefs, type AskRequest } from "../lib/ask.ts";
import { cacheKey, parseWebAnswer } from "../lib/ask-web.ts";
import { askClock, operationalItems } from "../lib/ask-operational.ts";
import { noticesContext, noticesKey, parseNotices, type NoticeSet } from "../lib/ask-notices.ts";
import { NOTICES_ERROR_TTL_MS, NOTICES_TTL_MS, NoticeLoader, type NoticesRpc } from "../lib/ask-notices-server.ts";

/** Avvisi operativi (fase F2) sul bundle del territorio di test; nessun nome di territorio. */
const here = dirname(fileURLToPath(import.meta.url));
let content: BundleContent;
let req: AskRequest;
let placeRef: string;
let routeRef: string;
let set: NoticeSet;

// 27 ottobre 2026, 14:35 a Roma.
const NOW = Date.UTC(2026, 9, 27, 13, 35);
const json = (o: unknown) => JSON.stringify(o);
const notice = (o: Record<string, unknown> = {}) => ({
  slug: "frana",
  status: "closed",
  lang: "it",
  title: "Sentiero chiuso per frana",
  text: "Tratto interdetto dal bivio 2.",
  place: null,
  route: routeRef,
  sourceUrl: "https://www.parco.example/avvisi/frana",
  validFrom: "2026-10-20",
  validUntil: "2026-11-15",
  verifiedAt: "2026-10-26T09:12:00+00:00",
  ...o,
});
const payload = (notices: unknown[], o: Record<string, unknown> = {}) => ({ territory: content.destination, today: "2026-10-27", lang: "it", notices, ...o });

beforeAll(() => {
  const { packs } = loadPacks(resolve(here, "../../../territories/_synthetic"));
  const dest = [...packs.values()].find((p) => p.manifest.kind === "destination")!;
  content = buildBundle(packs, { destination: dest.manifest.id, locale: "it", allowFictional: true }).content;
  placeRef = content.places[0]!.ref;
  routeRef = content.routes[0]!.ref;
  set = parseNotices(payload([notice()]), content.destination)!;
  req = askRequestSchema.parse({ destination: content.destination, locale: "it", question: "Il sentiero è aperto oggi?", selectedPlace: placeRef });
});

describe("lettura degli avvisi", () => {
  it("dalla funzione pubblica agli avvisi citabili", () => {
    expect(set).toEqual({
      state: "ok",
      today: "2026-10-27",
      notices: [
        {
          ref: "op:frana",
          status: "closed",
          title: "Sentiero chiuso per frana",
          text: "Tratto interdetto dal bivio 2.",
          route: routeRef,
          sourceUrl: "https://www.parco.example/avvisi/frana",
          validFrom: "2026-10-20",
          validUntil: "2026-11-15",
          verifiedOn: "2026-10-26",
        },
      ],
    });
  });

  it("scarta gli avvisi malformati, non in vigore o senza fonte https; un'altra destinazione è un errore", () => {
    const r = parseNotices(
      payload([
        notice({ slug: "ok" }),
        notice({ slug: "http", sourceUrl: "http://www.parco.example" }),
        notice({ slug: "futuro", validFrom: "2026-10-28" }),
        notice({ slug: "scaduto", validUntil: "2026-10-26" }),
        notice({ slug: "stato", status: "meteo" }),
        notice({ slug: "due", place: placeRef }),
        notice({ slug: "ok" }),
      ]),
      content.destination,
    );
    expect(r?.state === "ok" && r.notices.map((n) => n.ref)).toEqual(["op:ok"]);
    expect(parseNotices(payload([]), "altro.territorio")).toBeNull();
    expect(parseNotices({ notices: "x" }, content.destination)).toBeNull();
  });
});

describe("avvisi nel messaggio e nel controllo", () => {
  it("stanno nel messaggio della domanda, mai nella base in cache", () => {
    const clock = askClock(NOW, undefined, set);
    const msg = buildQuestionMessage(content, req, clock);
    expect(msg).toContain("AVVISI OPERATIVI (verificati dalla redazione");
    expect(msg).toContain(`- op:frana | percorso: ${content.routes[0]!.name} | stato: chiuso o interdetto | Sentiero chiuso per frana`);
    expect(msg).toContain("fonte: https://www.parco.example/avvisi/frana");
    expect(buildKnowledge(content)).not.toContain("op:frana");
    expect(SYSTEM_PROMPT).toContain("Nessun avviso non vuol dire che sia aperto");
  });

  it("nessun avviso o avvisi non disponibili si dichiarano; senza avvisi previsti nessuna riga", () => {
    const name = (r: string) => r;
    expect(noticesContext({ state: "ok", today: "2026-10-27", notices: [] }, name).join("\n")).toContain("nessuno. Non vuol dire che tutto sia aperto");
    expect(noticesContext({ state: "unavailable" }, name).join("\n")).toContain("non disponibili in questo momento");
    expect(noticesContext(undefined, name)).toEqual([]);
    expect(buildQuestionMessage(content, req, askClock(NOW))).not.toMatch(/^AVVISI OPERATIVI/m);
  });

  it("uno stato di oggi passa citando un avviso in vigore, con i suoi numeri e la sua fonte", () => {
    const clock = askClock(NOW, undefined, set);
    const raw = json({ status: "answered", answer: "Oggi il sentiero è chiuso: un avviso del Parco segnala il tratto interdetto dal bivio 2 fino al 15 novembre.", citations: ["op:frana"] });
    const r = checkModelAnswer(raw, content, req, clock);
    expect(r).toMatchObject({ ok: true, answer: { citations: ["op:frana"], notices: [{ ref: "op:frana", url: "https://www.parco.example/avvisi/frana", verifiedOn: "2026-10-26", validUntil: "2026-11-15" }] } });
    // Senza avvisi l'avviso non esiste: citazione inventata.
    expect(checkModelAnswer(raw, content, req, askClock(NOW))).toMatchObject({ ok: false, reason: "citazioni inesistenti: op:frana" });
    // Con avvisi non disponibili lo stato non si può dire.
    const bare = json({ status: "answered", answer: "Oggi il sentiero è chiuso.", citations: [content.assertions[0]!.ref] });
    expect(checkModelAnswer(bare, content, req, askClock(NOW, undefined, { state: "unavailable" }))).toMatchObject({ ok: false });
  });

  it("numeri non scritti nell'avviso si rifiutano", () => {
    const raw = json({ status: "answered", answer: "Il sentiero è chiuso per 3 settimane.", citations: ["op:frana"] });
    expect(checkModelAnswer(raw, content, req, askClock(NOW, undefined, set))).toMatchObject({ ok: false, reason: "numeri non presenti nelle fonti citate: 3" });
  });

  it("il riferimento scritto nel testo si toglie e si controlla come citazione", () => {
    expect(extractTextRefs("Il sentiero è chiuso (op:frana).")).toEqual({ text: "Il sentiero è chiuso.", refs: ["op:frana"] });
  });

  it("le risposte con ricerca possono citare gli avvisi", () => {
    const parsed = parseWebAnswer([{ type: "text", text: "Il sentiero è chiuso [[op:frana]]." }], content, req, set);
    expect(parsed.packCitations).toEqual(["op:frana"]);
    expect(parseWebAnswer([{ type: "text", text: "Chiuso [[op:frana]]." }], content, req).unknownRefs).toEqual(["op:frana"]);
  });

  it("la cache distingue gli avvisi", () => {
    const k = (s: NoticeSet | undefined) => cacheKey(req, "kb", noticesKey(s));
    expect(k(set)).not.toBe(k(undefined));
    expect(k(set)).not.toBe(k({ state: "unavailable" }));
    expect(k(set)).not.toBe(k(parseNotices(payload([notice({ status: "open" })]), content.destination)!));
    expect(k(set)).toBe(k(parseNotices(payload([notice()]), content.destination)!));
  });

  it("gli avvisi si aggiungono ai dati pratici solo quando ci sono", () => {
    expect(operationalItems(content).some((i) => i.kind === "notice")).toBe(false);
    expect(operationalItems(content, set).filter((i) => i.kind === "notice").map((i) => i.ref)).toEqual(["op:frana"]);
  });
});

describe("caricamento degli avvisi sul server", () => {
  const silence = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("senza Supabase nessun avviso; con la destinazione assente nemmeno", async () => {
    expect(await new NoticeLoader(null).load("a.b", "it")).toBeUndefined();
    expect(await new NoticeLoader(async () => ({ data: null, error: null })).load("a.b", "it")).toBeUndefined();
  });

  it("una lettura al minuto per destinazione e lingua", async () => {
    let t = 0;
    const rpc = vi.fn<NoticesRpc>(async () => ({ data: payload([notice()]), error: null }));
    const loader = new NoticeLoader(rpc, () => t);
    const first = await loader.load(content.destination, "it");
    expect(first?.state).toBe("ok");
    await loader.load(content.destination, "it");
    expect(rpc).toHaveBeenCalledTimes(1);
    await loader.load(content.destination, "en");
    expect(rpc).toHaveBeenCalledTimes(2);
    t = NOTICES_TTL_MS + 1;
    await loader.load(content.destination, "it");
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("errori, risposte malformate e tempo scaduto: non disponibili, ricordati poco", async () => {
    const warn = silence();
    let t = 0;
    const rpc = vi.fn<NoticesRpc>(async () => ({ data: null, error: { code: "57014" } }));
    const loader = new NoticeLoader(rpc, () => t);
    expect(await loader.load("a.b", "it")).toEqual({ state: "unavailable" });
    t = NOTICES_ERROR_TTL_MS + 1;
    await loader.load("a.b", "it");
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(await new NoticeLoader(async () => ({ data: { territory: "a.b" }, error: null })).load("a.b", "it")).toEqual({ state: "unavailable" });
    expect(await new NoticeLoader(async () => { throw new Error("rete"); }).load("a.b", "it")).toEqual({ state: "unavailable" });
    let aborted = false;
    const slow: NoticesRpc = (_args, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => (aborted = true));
        setTimeout(() => resolve({ data: null, error: null }), 200);
      });
    expect(await new NoticeLoader(slow, Date.now, 20).load("a.b", "it")).toEqual({ state: "unavailable" });
    expect(aborted).toBe(true);
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(JSON.stringify({ event: "notices_unavailable", code: "timeout" }));
    warn.mockRestore();
  });

  it("migrazione non ancora applicata: come senza avvisi", async () => {
    const warn = silence();
    expect(await new NoticeLoader(async () => ({ data: null, error: { code: "PGRST202" } })).load("a.b", "it")).toBeUndefined();
    warn.mockRestore();
  });
});
