import { describe, expect, it } from "vitest";
import { compass, formatDistance, formatStudioTime } from "../lib/format.ts";

describe("formattazione", () => {
  it("distanze leggibili", () => {
    expect(formatDistance(3, "it")).toBe("5 m");
    expect(formatDistance(37, "it")).toBe("35 m");
    expect(formatDistance(126, "it")).toBe("130 m");
    expect(formatDistance(1234, "it")).toBe("1,2 km");
    expect(formatDistance(1234, "en")).toBe("1.2 km");
  });
  it("direzioni cardinali", () => {
    const w = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    expect(compass(0, w)).toBe("N");
    expect(compass(350, w)).toBe("N");
    expect(compass(44, w)).toBe("NE");
    expect(compass(180, w)).toBe("S");
    expect(compass(-90, w)).toBe("W");
  });
});

describe("ora dello Studio", () => {
  it("in ora italiana anche se il server è in UTC (estate +2, inverno +1)", () => {
    expect(formatStudioTime("2026-10-18T16:07:13Z")).toBe("18/10/2026, 18:07:13");
    expect(formatStudioTime("2026-12-01T09:00:00Z")).toBe("01/12/2026, 10:00:00");
  });
});
