import { describe, expect, it } from "vitest";
import {
  addDays,
  datesInRange,
  daysBetween,
  eventsByDay,
  eventTimes,
  isIsoDate,
  isLocalTime,
  isOver,
  isValidTimeZone,
  localDate,
  localTime,
  localToInstant,
  MAX_URL_LENGTH,
  PUBLIC_HTTPS_URL_PATTERN,
  resolveRange,
  safeHttpsUrl,
  startOfLocalDay,
  territoryToday,
  touchesDay,
} from "../lib/local-events.ts";

const ROME = "Europe/Rome";
const iso = (ms: number) => new Date(ms).toISOString();
const ev = (startsAt: string, endsAt: string, id = "e") => ({ id, startsAt, endsAt });

describe("fusi orari", () => {
  it("riconosce i nomi IANA e rifiuta quelli inventati", () => {
    expect(isValidTimeZone(ROME)).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Europe/Portovenere")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("oggi è la data del territorio, non quella di UTC", () => {
    // 22:30 UTC del 19 ottobre: a Roma è già il 20, a New York ancora il 19.
    const now = Date.UTC(2026, 9, 19, 22, 30);
    expect(territoryToday(ROME, now)).toBe("2026-10-20");
    expect(territoryToday("America/New_York", now)).toBe("2026-10-19");
    expect(territoryToday("UTC", now)).toBe("2026-10-19");
  });

  it("data e ora locali di un istante", () => {
    const t = Date.UTC(2026, 6, 1, 19, 0); // 1 luglio, 21:00 a Roma (ora legale)
    expect(localDate(t, ROME)).toBe("2026-07-01");
    expect(localTime(t, ROME)).toBe("21:00");
    expect(localTime(Date.UTC(2026, 0, 15, 19, 0), ROME)).toBe("20:00"); // gennaio: ora solare
  });
});

describe("date di calendario", () => {
  it("accetta solo date esistenti AAAA-MM-GG", () => {
    expect(isIsoDate("2026-10-19")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2027-02-29")).toBe(false);
    expect(isIsoDate("2026-04-31")).toBe(false);
    expect(isIsoDate("2026-1-5")).toBe(false);
    expect(isIsoDate("19/10/2026")).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });

  it("orari HH:MM", () => {
    expect(isLocalTime("00:00")).toBe(true);
    expect(isLocalTime("23:59")).toBe(true);
    expect(isLocalTime("24:00")).toBe(false);
    expect(isLocalTime("9:30")).toBe(false);
  });

  it("aritmetica dei giorni anche attraverso fine mese, anno e cambio d'ora", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(daysBetween("2026-10-19", "2026-10-25")).toBe(6);
    expect(datesInRange("2026-10-24", "2026-10-26")).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
  });
});

describe("periodo dell'API", () => {
  const today = "2026-10-19";
  it("predefinito: oggi e i sei giorni seguenti", () => {
    expect(resolveRange({}, today)).toEqual({ ok: true, from: "2026-10-19", to: "2026-10-25" });
    expect(resolveRange({ from: "2026-10-22" }, today)).toEqual({ ok: true, from: "2026-10-22", to: "2026-10-28" });
  });
  it("al massimo 14 giorni, estremi inclusi", () => {
    expect(resolveRange({ from: today, to: "2026-11-01" }, today)).toEqual({ ok: true, from: today, to: "2026-11-01" });
    expect(resolveRange({ from: today, to: "2026-11-02" }, today)).toEqual({ ok: false, error: "periodo_troppo_lungo" });
  });
  it("un giorno solo, periodo rovesciato, date non valide", () => {
    expect(resolveRange({ from: today, to: today }, today)).toEqual({ ok: true, from: today, to: today });
    expect(resolveRange({ from: "2026-10-20", to: today }, today)).toEqual({ ok: false, error: "periodo_rovesciato" });
    expect(resolveRange({ from: "2026-02-30" }, today)).toEqual({ ok: false, error: "data_non_valida" });
    expect(resolveRange({ from: today, to: "domani" }, today)).toEqual({ ok: false, error: "data_non_valida" });
  });
});

describe("da ora locale a istante, con il cambio dell'ora", () => {
  it("un'ora normale d'estate e d'inverno", () => {
    expect(localToInstant("2026-07-01", "21:00", ROME)).toEqual({ status: "ok", instant: Date.UTC(2026, 6, 1, 19, 0) });
    expect(localToInstant("2026-01-15", "21:00", ROME)).toEqual({ status: "ok", instant: Date.UTC(2026, 0, 15, 20, 0) });
  });

  it("29 marzo 2026, 02:30 a Roma non esiste (si passa dalle 02:00 alle 03:00)", () => {
    const r = localToInstant("2026-03-29", "02:30", ROME);
    expect(r.status).toBe("nonexistent");
    expect(localTime(r.instant, ROME)).toBe("03:30");
    expect(localToInstant("2026-03-29", "03:00", ROME)).toEqual({ status: "ok", instant: Date.UTC(2026, 2, 29, 1, 0) });
  });

  it("25 ottobre 2026, 02:30 a Roma esiste due volte: si dichiara ambiguo", () => {
    const r = localToInstant("2026-10-25", "02:30", ROME);
    expect(r).toEqual({ status: "ambiguous", instant: Date.UTC(2026, 9, 25, 0, 30) });
    expect(localToInstant("2026-10-25", "03:30", ROME).status).toBe("ok");
  });

  it("i giorni del cambio d'ora durano 23 e 25 ore", () => {
    expect(startOfLocalDay("2026-03-30", ROME) - startOfLocalDay("2026-03-29", ROME)).toBe(23 * 3_600_000);
    expect(startOfLocalDay("2026-10-26", ROME) - startOfLocalDay("2026-10-25", ROME)).toBe(25 * 3_600_000);
  });

  it("un fuso diverso, stessa logica", () => {
    // New York: ora legale dall'8 marzo 2026 alle 02:00.
    expect(localToInstant("2026-03-08", "02:30", "America/New_York").status).toBe("nonexistent");
    expect(localToInstant("2026-07-04", "21:00", "America/New_York")).toEqual({ status: "ok", instant: Date.UTC(2026, 6, 5, 1, 0) });
  });
});

describe("intervallo di un evento", () => {
  const base = { startDate: "2026-07-31", startTime: null, endDate: null, endTime: null };

  it("orario da confermare: occupa tutta la giornata locale", () => {
    const r = eventTimes(base, ROME);
    expect(r).toEqual({ ok: true, startsAt: Date.UTC(2026, 6, 30, 22, 0), endsAt: Date.UTC(2026, 6, 31, 22, 0), timeKnown: false });
  });

  it("orario d'inizio senza fine: fino alla fine del giorno", () => {
    const r = eventTimes({ ...base, startTime: "21:00" }, ROME);
    expect(r).toMatchObject({ ok: true, startsAt: Date.UTC(2026, 6, 31, 19, 0), endsAt: Date.UTC(2026, 6, 31, 22, 0), timeKnown: true });
  });

  it("dalle 22 alle 2 del giorno dopo", () => {
    const r = eventTimes({ ...base, startTime: "22:00", endDate: "2026-08-01", endTime: "02:00" }, ROME);
    expect(r).toMatchObject({ ok: true, startsAt: Date.UTC(2026, 6, 31, 20, 0), endsAt: Date.UTC(2026, 6, 31, 24, 0) });
  });

  it("fine nello stesso giorno se manca la data di fine", () => {
    const r = eventTimes({ ...base, startTime: "18:00", endTime: "20:30" }, ROME);
    expect(r).toMatchObject({ ok: true, endsAt: Date.UTC(2026, 6, 31, 18, 30) });
  });

  it("più giorni senza orario: fino alla fine dell'ultimo giorno", () => {
    const r = eventTimes({ ...base, endDate: "2026-08-02" }, ROME);
    expect(r).toMatchObject({ ok: true, endsAt: Date.UTC(2026, 7, 2, 22, 0) });
  });

  it("errori: fine prima dell'inizio, fine con orario ma inizio senza, troppo lungo, formato", () => {
    expect(eventTimes({ ...base, startTime: "22:00", endTime: "02:00" }, ROME)).toEqual({ ok: false, error: "fine_prima_inizio" });
    expect(eventTimes({ ...base, endDate: "2026-07-30" }, ROME)).toEqual({ ok: false, error: "fine_prima_inizio" });
    expect(eventTimes({ ...base, endTime: "23:00" }, ROME)).toEqual({ ok: false, error: "fine_senza_inizio" });
    expect(eventTimes({ ...base, endDate: "2026-10-15" }, ROME)).toEqual({ ok: false, error: "troppo_lungo" });
    expect(eventTimes({ ...base, startDate: "2026-02-30" }, ROME)).toEqual({ ok: false, error: "formato" });
    expect(eventTimes({ ...base, startTime: "25:00" }, ROME)).toEqual({ ok: false, error: "formato" });
  });

  it("orari del cambio d'ora rifiutati, sia all'inizio sia alla fine", () => {
    expect(eventTimes({ startDate: "2026-03-29", startTime: "02:30", endDate: null, endTime: null }, ROME))
      .toEqual({ ok: false, error: "orario_inesistente" });
    expect(eventTimes({ startDate: "2026-10-24", startTime: "22:00", endDate: "2026-10-25", endTime: "02:30" }, ROME))
      .toEqual({ ok: false, error: "orario_ambiguo" });
  });
});

describe("eventi per giorno", () => {
  // Ottobre, ora legale fino al 25: mezzanotte a Roma = 22:00 UTC del giorno prima.
  const overnight = ev("2026-10-20T20:00:00.000Z", "2026-10-21T00:00:00.000Z", "notte"); // 22:00 → 02:00
  const allDay = ev("2026-10-20T22:00:00.000Z", "2026-10-21T22:00:00.000Z", "giornata"); // 21 ottobre, tutto il giorno
  const endsAtMidnight = ev("2026-10-20T18:00:00.000Z", "2026-10-20T22:00:00.000Z", "fino-a-mezzanotte"); // 20:00 → 00:00

  it("un evento oltre la mezzanotte compare in entrambi i giorni, non nel terzo", () => {
    expect(touchesDay(overnight, "2026-10-20", ROME)).toBe(true);
    expect(touchesDay(overnight, "2026-10-21", ROME)).toBe(true);
    expect(touchesDay(overnight, "2026-10-22", ROME)).toBe(false);
  });

  it("un evento che finisce alla mezzanotte resta nel suo giorno", () => {
    expect(touchesDay(endsAtMidnight, "2026-10-20", ROME)).toBe(true);
    expect(touchesDay(endsAtMidnight, "2026-10-21", ROME)).toBe(false);
  });

  it("il giorno di 25 ore del 25 ottobre comprende l'ora in più", () => {
    const lastHour = ev("2026-10-25T22:00:00.000Z", "2026-10-25T22:30:00.000Z"); // 23:00 CET del 25
    expect(touchesDay(lastHour, "2026-10-25", ROME)).toBe(true);
    expect(touchesDay(lastHour, "2026-10-26", ROME)).toBe(false);
  });

  it("gli eventi finiti escono dalle liste; ordine per inizio", () => {
    const now = Date.parse("2026-10-20T23:00:00.000Z"); // 01:00 del 21 a Roma
    expect(isOver(endsAtMidnight, now)).toBe(true);
    const days = eventsByDay([allDay, endsAtMidnight, overnight], ["2026-10-20", "2026-10-21"], ROME, now);
    expect(days.get("2026-10-20")!.map((e) => e.id)).toEqual(["notte"]);
    expect(days.get("2026-10-21")!.map((e) => e.id)).toEqual(["notte", "giornata"]);
  });

  it("lo stesso evento cade in giorni diversi in territori con fusi diversi", () => {
    const e = ev("2026-10-21T02:00:00.000Z", "2026-10-21T03:00:00.000Z"); // 04:00 a Roma, 22:00 del 20 a New York
    expect(touchesDay(e, "2026-10-21", ROME)).toBe(true);
    expect(touchesDay(e, "2026-10-20", "America/New_York")).toBe(true);
    expect(touchesDay(e, "2026-10-21", "America/New_York")).toBe(false);
  });

  it("nessun evento: giorni presenti e vuoti", () => {
    const days = eventsByDay([], ["2026-10-20"], ROME, 0);
    expect(days.get("2026-10-20")).toEqual([]);
  });

  it("indipendente dal fuso del processo: tutto passa dal fuso esplicito", () => {
    const r = eventTimes({ startDate: "2026-07-31", startTime: "21:00", endDate: null, endTime: null }, ROME);
    expect(r.ok && iso(r.startsAt)).toBe("2026-07-31T19:00:00.000Z");
  });
});

describe("indirizzi delle fonti", () => {
  it("accetta https ben formati e li normalizza", () => {
    expect(safeHttpsUrl("https://www.comune.example.it/eventi/sagra?anno=2026")).toBe("https://www.comune.example.it/eventi/sagra?anno=2026");
    expect(safeHttpsUrl("https://Example.org")).toBe("https://example.org/");
    expect(safeHttpsUrl("https://example.org:8443/a")).toBe("https://example.org:8443/a");
    expect(safeHttpsUrl("https://café.example/")).toBe("https://xn--caf-dma.example/");
  });

  it("rifiuta schemi diversi da https", () => {
    for (const u of ["javascript:alert(1)", "data:text/html,ciao", "http://example.org/", "ftp://example.org/", "mailto:a@example.org", "//example.org/"]) {
      expect(safeHttpsUrl(u), u).toBeNull();
    }
  });

  it("rifiuta credenziali, spazi, caratteri di controllo, host senza dominio, IPv6", () => {
    for (const u of [
      "https://utente:segreto@example.org/",
      "https://utente@example.org/",
      "https://example.org/a b",
      " https://example.org/",
      "https://example.org/\n",
      "https://example.org/\u0000",
      "https://localhost/",
      "https://[::1]/",
      "https://-example.org/",
      "https:example.org",
    ]) {
      expect(safeHttpsUrl(u), JSON.stringify(u)).toBeNull();
    }
  });

  it("rifiuta valori non testuali, vuoti o troppo lunghi", () => {
    expect(safeHttpsUrl(undefined)).toBeNull();
    expect(safeHttpsUrl(42)).toBeNull();
    expect(safeHttpsUrl("")).toBeNull();
    expect(safeHttpsUrl(`https://example.org/${"a".repeat(MAX_URL_LENGTH)}`)).toBeNull();
  });

  it("ciò che si accetta rispetta anche la regola del database", () => {
    const re = new RegExp(PUBLIC_HTTPS_URL_PATTERN);
    for (const u of ["https://example.org", "https://a.b.example.it/x?y=1#z", "https://café.example/"]) {
      const ok = safeHttpsUrl(u);
      expect(ok && re.test(ok), u).toBe(true);
    }
  });
});
