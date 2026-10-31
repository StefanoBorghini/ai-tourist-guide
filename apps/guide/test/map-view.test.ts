import { describe, expect, it } from "vitest";
import { fitView, metersPerPixel, panBy, placeLabels, project, scaleBar, toScreen, unproject, visibleTiles } from "../lib/map-view.ts";

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

  it("i tile visibili coprono tutto il riquadro", () => {
    const tiles = visibleTiles({ center: [9.85, 44.04], zoom: 16 }, 320, 260);
    expect(Math.min(...tiles.map((t) => t.left))).toBeLessThanOrEqual(0);
    expect(Math.max(...tiles.map((t) => t.left + 256))).toBeGreaterThanOrEqual(320);
    expect(Math.min(...tiles.map((t) => t.top))).toBeLessThanOrEqual(0);
    expect(Math.max(...tiles.map((t) => t.top + 256))).toBeGreaterThanOrEqual(260);
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

describe("pizzico", () => {
  it("ignora i piccoli movimenti delle dita e fa uno scatto solo oltre la soglia", async () => {
    const { pinchStep } = await import("../lib/map-view.ts");
    expect(pinchStep(100, 120)).toBe(0);
    expect(pinchStep(100, 150)).toBe(0);
    expect(pinchStep(100, 160)).toBe(1);
    expect(pinchStep(100, 70)).toBe(0);
    expect(pinchStep(100, 62)).toBe(-1);
    expect(pinchStep(0, 50)).toBe(0);
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
