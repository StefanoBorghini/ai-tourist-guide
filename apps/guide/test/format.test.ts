import { describe, expect, it } from "vitest";
import { compass, formatDistance } from "../lib/format.ts";

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
