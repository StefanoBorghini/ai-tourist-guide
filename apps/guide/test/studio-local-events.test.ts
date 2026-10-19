import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  eventPayloadFromForm, eventTitle, eventWhen, formatStamp, formValuesFromEvent, inView, publishBlockers, type FormValues, type StudioEvent,
} from "../lib/studio/local-events.ts";

const base: FormValues = {
  title_it: "  Concerto in piazza ",
  category: "music",
  startDate: "2026-10-24",
  startTime: "21:00",
  venueName: "Piazza del Borgo",
};
const parse = (extra: FormValues = {}, locales = ["it", "en"], def = "it") => eventPayloadFromForm({ ...base, ...extra }, locales, def);
const err = (extra: FormValues) => {
  const r = parse(extra);
  return r.ok ? null : r.error;
};

describe("modulo dell'evento → dati per il database", () => {
  it("campi minimi: testi ripuliti, vuoti a null, prezzo e stato predefiniti", () => {
    const r = parse();
    expect(r).toEqual({
      ok: true,
      payload: {
        labels: { it: { title: "Concerto in piazza" } },
        category: "music",
        startDate: "2026-10-24",
        startTime: "21:00",
        endDate: null,
        endTime: null,
        place: null,
        venueName: "Piazza del Borgo",
        venueAddress: null,
        lat: null,
        lng: null,
        organizer: null,
        sourceUrl: null,
        infoUrl: null,
        bookingUrl: null,
        price: "unknown",
        priceNote: null,
        languages: [],
        status: "scheduled",
        statusNote: null,
      },
    });
  });

  it("solo le lingue del territorio; titolo obbligatorio nella lingua principale", () => {
    const r = parse({ title_en: "Square concert", summary_en: "Live", title_fr: "Concert" });
    expect(r.ok && r.payload.labels).toEqual({ it: { title: "Concerto in piazza" }, en: { title: "Square concert", summary: "Live" } });
    expect(err({ title_it: " " })).toMatch(/titolo in IT/);
    expect(parse({ title_it: "", title_en: "Only en" }, ["it", "en"], "en").ok).toBe(true);
  });

  it("date e orari: formato, fine senza inizio rifiutata", () => {
    expect(err({ category: "sport" })).toMatch(/categoria/);
    expect(err({ startDate: "24/10/2026" })).toMatch(/data di inizio/);
    expect(err({ endDate: "2026-02-30" })).toMatch(/data di fine/);
    expect(err({ startTime: "9.30" })).toMatch(/21:00/);
    expect(err({ startTime: "", endTime: "23:00" })).toMatch(/orario di fine richiede/);
    expect(parse({ startTime: "", endDate: "2026-10-26" }).ok).toBe(true);
  });

  it("coordinate: entrambe o nessuna, virgola decimale accettata", () => {
    expect(err({ lat: "44.05" })).toMatch(/latitudine e longitudine/);
    expect(err({ lat: "95", lng: "9" })).toMatch(/non valide/);
    expect(err({ lat: "abc", lng: "9" })).toMatch(/non valide/);
    const r = parse({ lat: "44,0505", lng: "9.8357" });
    expect(r.ok && [r.payload.lat, r.payload.lng]).toEqual([44.0505, 9.8357]);
  });

  it("indirizzi: solo https completi, normalizzati come li accetta il database", () => {
    expect(err({ sourceUrl: "http://comune.example.it/eventi" })).toMatch(/fonte ufficiale.*https:\/\//);
    expect(err({ infoUrl: "https:example.org" })).toMatch(/informazioni/);
    expect(err({ bookingUrl: "https://utente:pw@prenota.example.it" })).toMatch(/prenotazione/);
    expect(err({ sourceUrl: "javascript:alert(1)" })).toMatch(/fonte/);
    const r = parse({ sourceUrl: "https://Comune.Example.it/eventi" });
    expect(r.ok && r.payload.sourceUrl).toBe("https://comune.example.it/eventi");
  });

  it("valori chiusi, lunghezze e identificativo come i vincoli della tabella", () => {
    expect(err({ price: "gratis" })).toMatch(/Prezzo/);
    expect(err({ status: "done" })).toMatch(/Stato/);
    expect(err({ venueName: "" })).toMatch(/nome del luogo/);
    expect(err({ venueName: "x".repeat(161) })).toMatch(/al massimo 160/);
    expect(err({ title_it: "x".repeat(141) })).toMatch(/Titolo \(it\): al massimo 140/);
    expect(err({ slug: "Concerto 1" })).toMatch(/identificativo/);
    expect(err({ slug: "a-" })).toMatch(/identificativo/);
    const r = parse({ slug: "concerto-2026", languages: "it, EN, it" });
    expect(r.ok && [r.payload.slug, r.payload.languages]).toEqual(["concerto-2026", ["it", "en"]]);
    expect(err({ languages: "italiano" })).toMatch(/due lettere/);
  });
});

const event: StudioEvent = {
  id: "00000000-0000-4000-8000-000000000001",
  pack: "zz.prova",
  slug: "concerto-20261024",
  labels: { it: { title: "Concerto" }, en: { title: "Concert", summary: "Live" } },
  category: "music",
  startDate: "2026-10-24",
  startTime: "21:00",
  endDate: "2026-10-25",
  endTime: "01:30",
  startsAt: "2026-10-24T19:00:00+00:00",
  endsAt: "2026-10-24T23:30:00+00:00",
  place: null,
  venueName: "Piazza",
  venueAddress: null,
  lat: 44.05,
  lng: 9.83,
  organizer: null,
  sourceUrl: "https://comune.example.it/e",
  infoUrl: null,
  bookingUrl: null,
  price: "free",
  priceNote: null,
  languages: ["it", "en"],
  seriesId: null,
  status: "scheduled",
  statusNote: null,
  publication: "draft",
  verifiedAt: null,
  verifiedBy: null,
  verificationNote: null,
  createdAt: "2026-10-19T10:00:00+00:00",
  updatedAt: "2026-10-19T10:00:00+00:00",
  publishedAt: null,
};
const now = Date.parse("2026-10-20T10:00:00Z");

describe("presentazione e regole dello Studio", () => {
  it("quando: orario da confermare, stesso giorno, oltre la mezzanotte", () => {
    expect(eventWhen({ startDate: "2026-10-24", startTime: null, endDate: null, endTime: null })).toBe("24 ottobre 2026 · orario da confermare");
    expect(eventWhen({ startDate: "2026-10-24", startTime: "18:00", endDate: "2026-10-24", endTime: "20:00" })).toBe("24 ottobre 2026, 18:00–20:00");
    expect(eventWhen(event)).toBe("24 ottobre 2026, 21:00 → 25 ottobre 2026, 01:30");
  });

  it("cosa manca per pubblicare", () => {
    expect(publishBlockers({ ...event, sourceUrl: null }, now)).toEqual(["manca l'indirizzo della fonte ufficiale"]);
    expect(publishBlockers(event, now)).toEqual(["la fonte non è ancora stata verificata"]);
    expect(publishBlockers({ ...event, verifiedAt: "2026-10-19T12:00:00Z" }, now)).toEqual([]);
    expect(publishBlockers({ ...event, verifiedAt: "2026-10-19T12:00:00Z" }, Date.parse("2026-10-25T00:00:00Z"))).toEqual(["l'evento è già concluso"]);
  });

  it("viste dell'elenco", () => {
    const later = Date.parse("2026-10-26T00:00:00Z");
    expect(inView(event, "prossimi", now)).toBe(true);
    expect(inView(event, "bozze", now)).toBe(true);
    expect(inView(event, "pubblicati", now)).toBe(false);
    expect(inView({ ...event, publication: "published" }, "pubblicati", now)).toBe(true);
    expect(inView({ ...event, publication: "withdrawn" }, "prossimi", now)).toBe(false);
    expect(inView({ ...event, publication: "withdrawn" }, "ritirati", now)).toBe(true);
    expect(inView(event, "passati", later)).toBe(true);
    expect(inView({ ...event, publication: "published" }, "pubblicati", later)).toBe(false);
  });

  it("evento → modulo → stessi dati (andata e ritorno)", () => {
    const v = formValuesFromEvent(event, ["it", "en"]);
    const r = eventPayloadFromForm(v, ["it", "en"], "it");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).toMatchObject({
      labels: event.labels,
      startDate: event.startDate, startTime: event.startTime, endDate: event.endDate, endTime: event.endTime,
      lat: event.lat, lng: event.lng, sourceUrl: event.sourceUrl, price: "free", languages: ["it", "en"], status: "scheduled",
    });
    expect(r.payload).not.toHaveProperty("slug");
  });

  it("titolo e istanti nel fuso del territorio", () => {
    expect(eventTitle(event, "it")).toBe("Concerto");
    expect(eventTitle(event, "de")).toBe("Concerto");
    expect(eventTitle({ ...event, labels: {} }, "it")).toBe("concerto-20261024");
    expect(formatStamp("2026-10-20T16:05:00Z", "Europe/Rome")).toBe("2026-10-20 18:05");
    expect(formatStamp("2026-10-20T16:05:00Z", "Non/Esiste")).toBe("2026-10-20 16:05");
    expect(formatStamp(null, "Europe/Rome")).toBe("");
  });

  it("le azioni della scheda Eventi passano solo dalle funzioni studio_*, senza chiave di servizio", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const src = readFileSync(resolve(root, "app/studio/actions-events.ts"), "utf8");
    expect(src).toMatch(/^"use server";/);
    expect(src).not.toMatch(/SERVICE_ROLE|serviceKey|\.from\(|anthropic/i);
    for (const fn of ["studio_save_local_event", "studio_verify_local_event", "studio_set_local_event_publication", "studio_set_local_event_status", "studio_delete_local_event"]) {
      expect(src).toContain(`"${fn}"`);
    }
    expect((src.match(/await requireStaff\(\)/g) ?? []).length).toBe(5);
  });
});
