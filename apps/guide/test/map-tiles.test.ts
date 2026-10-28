import { describe, expect, it } from "vitest";
import { OSM_TILES, tileSourceFrom, tileUrl } from "../lib/map-view.ts";

describe("sfondo della mappa configurabile", () => {
  it("senza configurazione o con un modello non valido resta OpenStreetMap", () => {
    expect(tileSourceFrom(undefined, undefined)).toEqual(OSM_TILES);
    expect(tileSourceFrom("", "x")).toEqual(OSM_TILES);
    expect(tileSourceFrom("http://tiles.example.com/{z}/{x}/{y}.png", undefined)).toEqual(OSM_TILES);
    expect(tileSourceFrom("https://tiles.example.com/{z}/{x}.png", undefined)).toEqual(OSM_TILES);
    expect(tileSourceFrom("https://tiles.example.com/{z}/{x}/{y} .png", undefined)).toEqual(OSM_TILES);
    expect(tileSourceFrom("javascript:alert(1)//{z}{x}{y}", undefined)).toEqual(OSM_TILES);
  });

  it("modello del fornitore con attribuzione in solo testo", () => {
    const s = tileSourceFrom(" https://api.maptiler.com/maps/abc/256/{z}/{x}/{y}{r}.png?key=PUBBLICA ", " © MapTiler © OpenStreetMap\n");
    expect(s).toEqual({ template: "https://api.maptiler.com/maps/abc/256/{z}/{x}/{y}{r}.png?key=PUBBLICA", attribution: "© MapTiler © OpenStreetMap" });
    expect(tileUrl(s, 17, 69243, 47998, 1)).toBe("https://api.maptiler.com/maps/abc/256/17/69243/47998.png?key=PUBBLICA");
    expect(tileUrl(s, 17, 69243, 47998, 3)).toBe("https://api.maptiler.com/maps/abc/256/17/69243/47998@2x.png?key=PUBBLICA");
    expect(tileSourceFrom("https://t.example.com/{z}/{x}/{y}.png", "").attribution).toBe("© OpenStreetMap");
  });

  it("OpenStreetMap come prima", () => {
    expect(tileUrl(OSM_TILES, 3, 4, 5)).toBe("https://tile.openstreetmap.org/3/4/5.png");
  });
});
