import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  categoriesIn, countInRange, dayLabel, eventDays, eventsUrl, parseEventsData, rangeDates, stateFromResponse, timeLabel, verifiedDate,
  type EventsData, type PublicEvent,
} from "../lib/events-view.ts";

// Eventi come li restituisce public_local_events (fuso Europe/Rome, ora legale fino al 25 ottobre 2026).
const raw = (over: Record<string, unknown> = {}) => ({
  id: "e1", slug: "concerto", category: "music", status: "scheduled", statusNote: null, lang: "it",
  title: "Concerto", summary: "In piazza", description: null,
  start: { date: "2026-10-20", time: "21:00" }, end: { date: "2026-10-20", time: "23:00" },
  startsAt: "2026-10-20T19:00:00+00:00", endsAt: "2026-10-20T21:00:00+00:00", timeKnown: true,
  venue: { name: "Piazza", address: null, placeRef: null, lat: null, lng: null },
  price: { kind: "free", note: null }, organizer: null, languages: [],
  links: { source: "https://comune.example.it/e", info: null, booking: null },
  verifiedAt: "2026-10-19T08:00:00+00:00", updatedAt: "2026-10-19T08:00:00+00:00",
  ...over,
});
const response = (events: unknown[], today = "2026-10-20") => ({
  version: 1, territory: { id: "zz.prova", timezone: "Europe/Rome" }, today, range: { from: today, to: "2026-10-26" }, lang: "it", events,
});
const data = (events: unknown[], today?: string) => parseEventsData(response(events, today)) as EventsData;
const now = Date.parse("2026-10-20T10:00:00Z");
const words = { tbc: "Orario da confermare", allDay: "Tutto il giorno", until: (t: string) => `Fino alle ${t}` };

describe("lettura della risposta dell'API", () => {
  it("forma attesa → dati; forma diversa → null", () => {
    const d = data([raw()]);
    expect(d).toMatchObject({ territory: "zz.prova", timezone: "Europe/Rome", today: "2026-10-20" });
    expect(d.events[0]).toMatchObject({ id: "e1", title: "Concerto", timeKnown: true, price: { kind: "free" } });
    expect(parseEventsData(null)).toBeNull();
    expect(parseEventsData({ ...response([]), today: "20/10/2026" })).toBeNull();
    expect(parseEventsData({ ...response([]), territory: { id: "x", timezone: "Non/Esiste" } })).toBeNull();
    expect(parseEventsData({ ...response([]), events: "no" })).toBeNull();
  });

  it("eventi malformati scartati, valori sconosciuti ricondotti a quelli sicuri", () => {
    const d = data([raw({ id: "" }), raw({ id: "e2", startsAt: "ieri" }), raw({ id: "e3", category: "rave", status: "boh", price: { kind: "gratis" } })]);
    expect(d.events.map((e) => e.id)).toEqual(["e3"]);
    expect(d.events[0]).toMatchObject({ category: "other", status: "scheduled", price: { kind: "unknown" } });
  });

  it("link: solo https ben formati, ricontrollati anche se arrivano dal database", () => {
    const d = data([raw({ links: { source: "javascript:alert(1)", info: "http://x.example.it", booking: "https://prenota.example.it/a b" } })]);
    expect(d.events[0]!.links).toEqual({ source: null, info: null, booking: null });
  });
});

describe("viste Oggi, Domani, 7 giorni nel fuso del territorio", () => {
  it("giorni della vista a partire da «oggi» dell'API, non dal telefono", () => {
    expect(rangeDates("2026-10-20", "today")).toEqual(["2026-10-20"]);
    expect(rangeDates("2026-10-20", "tomorrow")).toEqual(["2026-10-21"]);
    expect(rangeDates("2026-10-31", "week")).toEqual(["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]);
  });

  it("un evento dalle 22 alle 2 compare oggi e domani; quello finito sparisce", () => {
    const late = raw({ id: "late", start: { date: "2026-10-20", time: "22:00" }, end: { date: "2026-10-21", time: "02:00" },
      startsAt: "2026-10-20T20:00:00+00:00", endsAt: "2026-10-21T00:00:00+00:00" });
    const gone = raw({ id: "gone", startsAt: "2026-10-20T06:00:00+00:00", endsAt: "2026-10-20T08:00:00+00:00" });
    const d = data([late, gone]);
    const f = { category: null, freeOnly: false };
    expect(eventDays(d, "today", f, now).map((x) => x.events.map((e) => e.id))).toEqual([["late"]]);
    expect(eventDays(d, "tomorrow", f, now).map((x) => x.events.map((e) => e.id))).toEqual([["late"]]);
    expect(eventDays(d, "week", f, now).map((x) => x.date)).toEqual(["2026-10-20", "2026-10-21"]);
    expect(countInRange(d, "week", now)).toBe(1);
  });

  it("cambio dell'ora del 25 ottobre: l'evento della domenica sta nel giorno giusto", () => {
    // 25/10/2026 10:00 a Roma = 09:00 UTC (ora solare); il giorno locale va dalle 22:00 UTC del 24 alle 23:00 UTC del 25.
    const sunday = raw({ id: "dom", start: { date: "2026-10-25", time: "23:30" }, end: { date: "2026-10-25", time: null },
      startsAt: "2026-10-25T22:30:00+00:00", endsAt: "2026-10-25T22:59:00+00:00" });
    const d = data([sunday]);
    const days = eventDays(d, "week", { category: null, freeOnly: false }, now);
    expect(days.map((x) => x.date)).toEqual(["2026-10-25"]);
  });

  it("filtri per categoria e gratuiti; categorie nell'ordine del vocabolario", () => {
    const d = data([
      raw({ id: "a", category: "outdoor", price: { kind: "paid", note: null } }),
      raw({ id: "b", category: "culture" }),
      raw({ id: "c", category: "outdoor" }),
    ]);
    const ids = (f: { category: "outdoor" | null; freeOnly: boolean }) => eventDays(d, "today", f, now).flatMap((x) => x.events.map((e) => e.id));
    expect(ids({ category: "outdoor", freeOnly: false }).sort()).toEqual(["a", "c"]);
    expect(ids({ category: "outdoor", freeOnly: true })).toEqual(["c"]);
    expect(ids({ category: null, freeOnly: true }).sort()).toEqual(["b", "c"]);
    expect(categoriesIn(d)).toEqual(["culture", "outdoor"]);
  });

  it("annullati e rinviati restano in elenco (con la loro etichetta)", () => {
    const d = data([raw({ id: "x", status: "cancelled", statusNote: "Maltempo" })]);
    expect(eventDays(d, "today", { category: null, freeOnly: false }, now)[0]!.events[0]).toMatchObject({ status: "cancelled", statusNote: "Maltempo" });
  });
});

describe("etichette", () => {
  const ev = (over: Record<string, unknown>) => data([raw(over)]).events[0] as PublicEvent;

  it("orario: stesso giorno, oltre la mezzanotte, giorno dopo, sconosciuto, più giorni", () => {
    expect(timeLabel(ev({}), "2026-10-20", "it", words)).toBe("21:00–23:00");
    const late = ev({ start: { date: "2026-10-20", time: "22:00" }, end: { date: "2026-10-21", time: "02:00" } });
    expect(timeLabel(late, "2026-10-20", "it", words)).toBe("22:00 → 21 ott, 02:00");
    expect(timeLabel(late, "2026-10-21", "it", words)).toBe("Fino alle 02:00");
    expect(timeLabel(ev({ start: { date: "2026-10-20", time: null }, end: { date: null, time: null }, timeKnown: false }), "2026-10-20", "it", words)).toBe("Orario da confermare");
    expect(timeLabel(ev({ start: { date: "2026-10-20", time: null }, end: { date: "2026-10-22", time: null }, timeKnown: false }), "2026-10-21", "it", words)).toBe("Tutto il giorno");
    expect(timeLabel(ev({ end: { date: null, time: null } }), "2026-10-20", "it", words)).toBe("21:00");
  });

  it("giorno: oggi e domani dal territorio, poi data per esteso nella lingua", () => {
    const w = { today: "Oggi", tomorrow: "Domani" };
    expect(dayLabel("2026-10-20", "2026-10-20", "it", w)).toBe("Oggi");
    expect(dayLabel("2026-10-21", "2026-10-20", "it", w)).toBe("Domani");
    expect(dayLabel("2026-10-24", "2026-10-20", "it", w)).toBe("sabato 24 ottobre");
    expect(dayLabel("2026-10-24", "2026-10-20", "en", w)).toBe("Saturday 24 October");
  });

  it("«Verificato il …» nel fuso del territorio", () => {
    expect(verifiedDate("2026-10-19T22:30:00Z", "Europe/Rome", "it")).toBe("20 ottobre 2026");
    expect(verifiedDate(null, "Europe/Rome", "it")).toBeNull();
  });
});

describe("richiesta ed esiti", () => {
  it("indirizzo: territorio e lingua, nient'altro", () => {
    expect(eventsUrl("it.liguria.sp.portovenere", "en")).toBe("/api/v1/events?territory=it.liguria.sp.portovenere&lang=en");
    expect(eventsUrl("a.b", null)).toBe("/api/v1/events?territory=a.b");
  });

  it("404 e servizio non configurato = nessun calendario; il resto è un errore da riprovare", () => {
    expect(stateFromResponse(200, response([raw()]))).toMatchObject({ kind: "ok" });
    expect(stateFromResponse(200, { strano: true })).toEqual({ kind: "error" });
    expect(stateFromResponse(404, { error: "territorio" })).toEqual({ kind: "unavailable" });
    expect(stateFromResponse(503, { error: "non_configurato" })).toEqual({ kind: "unavailable" });
    expect(stateFromResponse(503, { error: "non_disponibile" })).toEqual({ kind: "error" });
    expect(stateFromResponse(400, null)).toEqual({ kind: "error" });
  });

  it("gli eventi non entrano nel pacchetto offline né nelle domande all'AI", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    for (const file of ["lib/ask.ts", "lib/ask-server.ts", "lib/offline.ts", "public/sw.js"]) {
      const src = readFileSync(resolve(root, file), "utf8");
      expect(src, file).not.toMatch(/api\/v1\/events|local-events|events-view|EventsPanel/);
    }
    const sw = readFileSync(resolve(root, "public/sw.js"), "utf8");
    expect(sw).toMatch(/url\.pathname\.startsWith\("\/api\/"\)/);
  });
});
