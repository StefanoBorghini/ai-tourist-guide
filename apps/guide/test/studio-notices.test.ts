import { describe, expect, it } from "vitest";
import {
  formValuesFromNotice, inNoticeView, newNoticeValues, noticePayloadFromForm, noticePublishBlockers, noticeTiming, type StudioNotice,
} from "../lib/studio/operational-notices.ts";

const form = (values: Record<string, string>) => (name: string) => values[name] ?? "";
const base = { status: "closed", title_it: "  Sentiero   chiuso ", text_it: "Frana al bivio.", title_en: "", text_en: "", validFrom: "2026-10-27", validUntil: "2026-11-03", route: "sentiero", sourceUrl: "https://www.parco.example/avvisi" };
const notice = (o: Partial<StudioNotice> = {}): StudioNotice => ({
  id: "x", pack: "a.b", slug: "frana", status: "closed", labels: { it: { title: "Sentiero chiuso" } }, place: null, route: "sentiero",
  sourceUrl: "https://www.parco.example", validFrom: "2026-10-20", validUntil: "2026-11-03", today: "2026-10-27",
  publication: "draft", verifiedAt: null, verificationNote: null, publishedAt: null, ...o,
});

describe("avvisi nello Studio", () => {
  it("dal modulo al formato della funzione del database", () => {
    expect(noticePayloadFromForm(form(base), ["it", "en"], "it")).toEqual({
      ok: true,
      payload: { status: "closed", labels: { it: { title: "Sentiero chiuso", text: "Frana al bivio." } }, validFrom: "2026-10-27", validUntil: "2026-11-03", route: "sentiero", sourceUrl: "https://www.parco.example/avvisi" },
    });
  });

  it("messaggi chiari per i dati mancanti o sbagliati", () => {
    const err = (o: Record<string, string>) => noticePayloadFromForm(form({ ...base, ...o }), ["it", "en"], "it");
    expect(err({ status: "meteo" })).toEqual({ ok: false, error: "Scegli lo stato dell'avviso." });
    expect(err({ title_it: "" })).toMatchObject({ ok: false, error: "Scrivi il titolo nella lingua principale (it)." });
    expect(err({ validUntil: "2026-10-26" })).toMatchObject({ ok: false });
    expect(err({ validUntil: "2027-04-26" })).toMatchObject({ ok: false });
    expect(err({ place: "molo" })).toMatchObject({ ok: false, error: "Un avviso riguarda un luogo o un percorso, non entrambi." });
    expect(err({ sourceUrl: "http://www.parco.example" })).toMatchObject({ ok: false });
    expect(err({ title_en: "x".repeat(141) })).toMatchObject({ ok: false });
  });

  it("valori del modulo, validità e cosa manca per pubblicare", () => {
    expect(formValuesFromNotice(notice(), ["it", "en"])).toMatchObject({ status: "closed", title_it: "Sentiero chiuso", title_en: "", route: "sentiero", place: "" });
    expect(newNoticeValues("2026-10-27")).toEqual({ validFrom: "2026-10-27", validUntil: "2026-11-03" });
    expect(noticeTiming(notice())).toBe("current");
    expect(noticeTiming(notice({ validFrom: "2026-10-28" }))).toBe("future");
    expect(noticeTiming(notice({ validUntil: "2026-10-26" }))).toBe("expired");
    expect(noticePublishBlockers(notice())).toEqual(["la fonte non è ancora stata verificata"]);
    expect(noticePublishBlockers(notice({ sourceUrl: null, validUntil: "2026-10-26" }))).toEqual(["manca l'indirizzo della fonte ufficiale", "l'avviso è già scaduto"]);
    expect(noticePublishBlockers(notice({ verifiedAt: "2026-10-27T08:00:00Z" }))).toEqual([]);
  });

  it("viste dell'elenco", () => {
    expect(inNoticeView(notice(), "attivi")).toBe(true);
    expect(inNoticeView(notice({ publication: "withdrawn" }), "attivi")).toBe(false);
    expect(inNoticeView(notice({ validUntil: "2026-10-26" }), "attivi")).toBe(false);
    expect(inNoticeView(notice({ validUntil: "2026-10-26" }), "scaduti")).toBe(true);
    expect(inNoticeView(notice({ publication: "published" }), "pubblicati")).toBe(true);
  });
});
