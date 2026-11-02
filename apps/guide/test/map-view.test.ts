import { describe, expect, it } from "vitest";
import { fitView, metersPerPixel, panBy, placeLabels, project, scaleBar, toScreen, unproject } from "../lib/map-view.ts";

describe("geometria della mappa", () => {
  it("proietta e riproietta senza errori apprezzabili", () => {
    const p: [number, number] = [9.8485, 44.041];
    const [lng, lat] = unproject(project(p, 17), 17);
    expect(lng).toBeCloseTo(p[0], 7);
    expect(lat).toBeCloseTo(p[1], 7);
  });

  it("i tile allo zoom 0 coprono il mondo in 256 pixel", () => {
    expect(project([-180, 0], 0).x).toBeCloseTo(0);
    expect(project([180, 0], 0).x).toBeCloseTo(256);
    expect(project([0, 0], 0).y).toBeCloseTo(128);
  });

  it("l'inquadratura contiene tutti i punti, al massimo zoom possibile", () => {
    const pts: [number, number][] = [[9.84, 44.04], [9.85, 44.035], [9.845, 44.042]];
    const view = fitView(pts, 320, 260, 32);
    const s = toScreen(view, 320, 260);
    for (const p of pts) {
      const q = s(p);
      expect(q.x).toBeGreaterThanOrEqual(32 - 1);
      expect(q.x).toBeLessThanOrEqual(320 - 32 + 1);
      expect(q.y).toBeGreaterThanOrEqual(32 - 1);
      expect(q.y).toBeLessThanOrEqual(260 - 32 + 1);
    }
    // Uno zoom in più non basterebbe più.
    const tighter = toScreen({ ...view, zoom: view.zoom + 1 }, 320, 260);
    expect(pts.some((p) => { const q = tighter(p); return q.x < 32 || q.x > 288 || q.y < 32 || q.y > 228; })).toBe(true);
  });

  it("trascinare sposta il centro del verso giusto", () => {
    const view = { center: [9.85, 44.04] as [number, number], zoom: 16 };
    const moved = panBy(view, 100, 0); // trascino verso destra → vedo più a ovest
    expect(moved.center[0]).toBeLessThan(view.center[0]);
  });

  it("la scala grafica usa valori tondi e rispetta la lunghezza massima", () => {
    const s = scaleBar(44, 17, 90);
    expect([1, 2, 5].some((k) => Number((s.meters / 10 ** Math.floor(Math.log10(s.meters))).toFixed(6)) === k)).toBe(true);
    expect(s.px).toBeLessThanOrEqual(90);
    expect(s.meters / metersPerPixel(44, 17)).toBeCloseTo(s.px);
  });

  it("le etichette non si sovrappongono e le più importanti vincono", () => {
    const placed = placeLabels(
      [
        { id: "minore", x: 100, y: 100, text: "Luogo minore", priority: 1, offset: 6 },
        { id: "tappa", x: 102, y: 101, text: "Prossima tappa", priority: 100, offset: 10 },
        { id: "terza", x: 104, y: 102, text: "Terzo luogo vicino", priority: 50, offset: 6 },
      ],
      400,
      300,
    );
    expect(placed[0]!.id).toBe("tappa");
    const boxes = placed.map((p) => ({ y: p.y, x0: p.anchor === "start" ? p.x : p.x - p.text.length * 5.6, x1: p.anchor === "start" ? p.x + p.text.length * 5.6 : p.x }));
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!;
        const overlap = a.x0 < b.x1 && a.x1 > b.x0 && Math.abs(a.y - b.y) < 12;
        expect(overlap).toBe(false);
      }
  });
});

describe("tocchi sui simboli", () => {
  it("il simbolo più vicino entro il suo raggio, poi il nome, altrimenti niente", async () => {
    const { hitTarget } = await import("../lib/map-view.ts");
    const targets = [
      { id: "a", kind: "place" as const, x: 100, y: 100, r: 18 },
      { id: "b", kind: "place" as const, x: 120, y: 100, r: 18 },
      { id: "v", kind: "venue" as const, x: 200, y: 200, r: 16 },
      { id: "a", kind: "place" as const, box: { x0: 125, y0: 80, x1: 190, y1: 92 } },
    ];
    expect(hitTarget({ x: 104, y: 101 }, targets)).toEqual({ id: "a", kind: "place" });
    expect(hitTarget({ x: 116, y: 100 }, targets)).toEqual({ id: "b", kind: "place" });
    expect(hitTarget({ x: 205, y: 195 }, targets)).toEqual({ id: "v", kind: "venue" });
    expect(hitTarget({ x: 170, y: 85 }, targets)).toEqual({ id: "a", kind: "place" });
    expect(hitTarget({ x: 300, y: 300 }, targets)).toBeNull();
  });
});

describe("MapLibre", () => {
  it("zoom: MapLibre conta in tile da 512 px, un livello in meno", async () => {
    const { toGlZoom, fromGlZoom, metersPerPixel } = await import("../lib/map-view.ts");
    expect(toGlZoom(17)).toBe(16);
    expect(fromGlZoom(toGlZoom(15.37))).toBeCloseTo(15.37, 12);
    // Stessa scala: a zoom 17 (256) = zoom 16 (512) un pixel vale gli stessi metri.
    expect(metersPerPixel(44, 17)).toBeCloseTo((40075016.686 * Math.cos((44 * Math.PI) / 180)) / (512 * 2 ** toGlZoom(17)), 6);
  });

  it("modello dei tile: {z}/{x}/{y} restano a MapLibre, {r} si risolve con la densità", async () => {
    const { rasterTemplate, OSM_TILES } = await import("../lib/map-view.ts");
    const hd = { template: "https://tiles.example.com/{z}/{x}/{y}{r}.png?key=k", attribution: "© Esempio" };
    expect(rasterTemplate(hd, 2.625)).toBe("https://tiles.example.com/{z}/{x}/{y}@2x.png?key=k");
    expect(rasterTemplate(hd, 1)).toBe("https://tiles.example.com/{z}/{x}/{y}.png?key=k");
    expect(rasterTemplate(OSM_TILES, 3)).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  });
});

describe("etichette e simboli", () => {
  it("un'etichetta non copre il simbolo di un altro luogo", async () => {
    const { placeLabels } = await import("../lib/map-view.ts");
    // B sta subito a destra di A: l'etichetta di A deve andare a sinistra (o sparire), non sopra B.
    const placed = placeLabels(
      [
        { id: "A", x: 100, y: 100, text: "Luogo A", priority: 50, offset: 10 },
        { id: "B", x: 125, y: 100, text: "Luogo B", priority: 10, offset: 10 },
      ],
      400,
      300,
    );
    const a = placed.find((p) => p.id === "A");
    expect(a?.anchor).toBe("end");
  });
});
