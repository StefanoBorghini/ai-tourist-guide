import { describe, expect, it } from "vitest";
import { GPS_STALE_MS, gpsStatus } from "../lib/gps-status.ts";

const NOW = Date.UTC(2026, 9, 9, 10, 0, 0);
const fix = (accuracyM: number, ageMs = 1000) => ({ location: [9.83, 44.05] as const, accuracyM, timestamp: NOW - ageMs });
const base = { watching: true, simulating: false, error: null, source: "gps" as const, now: NOW };

describe("stato del GPS", () => {
  it("distingue spento, in attesa, buono e impreciso", () => {
    expect(gpsStatus({ ...base, watching: false, fix: null, source: null }).level).toBe("off");
    expect(gpsStatus({ ...base, fix: null, source: null }).level).toBe("waiting");
    expect(gpsStatus({ ...base, fix: fix(8) })).toEqual({ level: "ok", accuracyM: 8, ageS: 1 });
    expect(gpsStatus({ ...base, fix: fix(60) }).level).toBe("imprecise");
  });

  it("una posizione vecchia vuol dire segnale perso", () => {
    expect(gpsStatus({ ...base, fix: fix(8, GPS_STALE_MS + 1000) }).level).toBe("stale");
  });

  it("errori: permesso negato e dispositivo senza posizione prevalgono; segnale assente solo senza posizione", () => {
    expect(gpsStatus({ ...base, error: "denied", fix: null, source: null, watching: false }).level).toBe("denied");
    expect(gpsStatus({ ...base, error: "unavailable", fix: null, source: null, watching: false }).level).toBe("unavailable");
    expect(gpsStatus({ ...base, error: "timeout", fix: null, source: null }).level).toBe("no_signal");
    expect(gpsStatus({ ...base, error: "timeout", fix: fix(8) }).level).toBe("ok");
  });

  it("la posizione simulata non si confonde mai con quella reale", () => {
    expect(gpsStatus({ ...base, watching: false, simulating: true, fix: fix(8), source: "simulated" }).level).toBe("simulated");
    expect(gpsStatus({ ...base, watching: false, fix: fix(8), source: "simulated" }).level).toBe("simulated");
    // GPS appena acceso dopo una simulazione: finché non arriva una posizione vera, si aspetta.
    expect(gpsStatus({ ...base, fix: fix(8), source: "simulated" }).level).toBe("waiting");
  });
});
