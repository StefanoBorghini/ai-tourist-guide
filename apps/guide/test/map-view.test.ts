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

describe("zoom fluido", () => {
  const view = { center: [9.85, 44.04] as [number, number], zoom: 16 };

  it("pizzico continuo: raddoppiare la distanza tra le dita è un livello in più, entro i limiti", async () => {
    const { pinchZoom, MAX_ZOOM, MIN_ZOOM } = await import("../lib/map-view.ts");
    expect(pinchZoom(16, 100, 100)).toBe(16);
    expect(pinchZoom(16, 100, 200)).toBeCloseTo(17);
    expect(pinchZoom(16, 100, 141.42)).toBeCloseTo(16.5, 3);
    expect(pinchZoom(16, 100, 50)).toBeCloseTo(15);
    expect(pinchZoom(18.5, 100, 400)).toBe(MAX_ZOOM);
    expect(pinchZoom(4, 100, 10)).toBe(MIN_ZOOM);
    expect(pinchZoom(16, 0, 50)).toBe(16);
  });

  it("zoom intorno a un punto: il luogo sotto il dito resta sotto il dito", async () => {
    const { zoomAround } = await import("../lib/map-view.ts");
    const before = toScreen(view, 320, 260);
    const target: [number, number] = [9.852, 44.041];
    const p = before(target);
    for (const z of [16.3, 17, 18.7, 14.2]) {
      const after = toScreen(zoomAround(view, z, p.x, p.y, 320, 260), 320, 260)(target);
      expect(after.x).toBeCloseTo(p.x, 6);
      expect(after.y).toBeCloseTo(p.y, 6);
    }
    // Al centro del riquadro: cambia solo lo zoom.
    const centered = zoomAround(view, 17.5, 160, 130, 320, 260);
    expect(centered.center[0]).toBeCloseTo(view.center[0], 9);
    expect(centered.center[1]).toBeCloseTo(view.center[1], 9);
  });

  it("tile a zoom frazionario: livello più vicino, scalati, contigui, coprono il riquadro", async () => {
    const { tileLayers } = await import("../lib/map-view.ts");
    for (const zoom of [16, 16.3, 16.49, 16.6, 17.9]) {
      const tiles = visibleTiles({ ...view, zoom }, 320, 260);
      const z = Math.round(zoom);
      expect(tiles.every((t) => t.z === z)).toBe(true);
      expect(tiles[0]!.size).toBeCloseTo(256 * 2 ** (zoom - z), -0.5);
      expect(Math.min(...tiles.map((t) => t.left))).toBeLessThanOrEqual(0);
      expect(Math.max(...tiles.map((t) => t.left + t.size))).toBeGreaterThanOrEqual(320);
      expect(Math.min(...tiles.map((t) => t.top))).toBeLessThanOrEqual(0);
      expect(Math.max(...tiles.map((t) => t.top + t.size))).toBeGreaterThanOrEqual(260);
      // Nessuna fessura: il tile accanto comincia dove finisce il precedente.
      const row = tiles.filter((t) => t.y === tiles[0]!.y).sort((a, b) => a.left - b.left);
      for (let i = 1; i < row.length; i++) expect(row[i]!.left).toBe(row[i - 1]!.left + row[i - 1]!.size);
      // Un luogo cade sullo stesso pixel della mappa e dello sfondo.
      const placed = tiles.find((t) => t.x === Math.floor(project(view.center, z).x / 256) && t.y === Math.floor(project(view.center, z).y / 256))!;
      const inTile = (project(view.center, z).x / 256 - placed.x) * placed.size;
      expect(placed.left + inTile).toBeCloseTo(160, -0.5);
    }
    // Densità non intera e riquadro a metà di un pixel fisico nella pagina: i bordi cadono sui pixel fisici della
    // pagina (multipli di 1/2,625 px CSS contando la posizione del riquadro), sempre contigui.
    const grid = { ratio: 2.625, originX: 16.2, originY: 438.9375 };
    const dense = visibleTiles({ ...view, zoom: 16.37 }, 320, 260, undefined, grid);
    const onGrid = (v: number) => Math.abs(v * 2.625 - Math.round(v * 2.625)) < 1e-6;
    for (const t of dense) {
      expect(onGrid(grid.originX + t.left) && onGrid(grid.originX + t.left + t.size)).toBe(true);
      expect(onGrid(grid.originY + t.top) && onGrid(grid.originY + t.top + t.size)).toBe(true);
    }
    const denseRow = dense.filter((t) => t.y === dense[0]!.y).sort((a, b) => a.left - b.left);
    for (let i = 1; i < denseRow.length; i++) expect(denseRow[i]!.left).toBeCloseTo(denseRow[i - 1]!.left + denseRow[i - 1]!.size, 9);
    // A zoom intero, come prima: 256 px.
    expect(visibleTiles(view, 320, 260).every((t) => t.size === 256)).toBe(true);
    // Due strati: sotto il livello precedente, sopra quello giusto.
    const layers = tileLayers({ ...view, zoom: 16.4 }, 320, 260);
    expect([...new Set(layers.map((t) => t.z))]).toEqual([15, 16]);
  });
});

describe("sfondo durante il gesto e inerzia", () => {
  it("la trasformazione dello strato porta ogni luogo dove sta nella nuova inquadratura", async () => {
    const { layerTransform, zoomAround } = await import("../lib/map-view.ts");
    const from = { center: [9.85, 44.04] as [number, number], zoom: 16 };
    const targets: [number, number][] = [[9.852, 44.041], [9.847, 44.038], [9.85, 44.04]];
    for (const to of [zoomAround(from, 16.7, 100, 80, 320, 260), panBy(from, 40, -25), zoomAround(panBy(from, -30, 10), 15.2, 250, 200, 320, 260), from]) {
      const t = layerTransform(from, to, 320, 260);
      const a = toScreen(from, 320, 260);
      const b = toScreen(to, 320, 260);
      for (const p of targets) {
        expect(t.x + t.scale * a(p).x).toBeCloseTo(b(p).x, 6);
        expect(t.y + t.scale * a(p).y).toBeCloseTo(b(p).y, 6);
      }
    }
    expect(layerTransform(from, from, 320, 260)).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("copertura dello strato: fermo, spostato, rimpicciolito vicino al bordo", async () => {
    const { layerCovers, layerTransform, zoomAround } = await import("../lib/map-view.ts");
    const from = { center: [9.85, 44.04] as [number, number], zoom: 14 };
    const [w, h, mx, my] = [320, 260, 160, 130];
    expect(layerCovers(layerTransform(from, from, w, h), w, h, mx, my, 50)).toBe(true);
    // Spostato di poco: coperto; oltre il margine: scoperto.
    expect(layerCovers(layerTransform(from, panBy(from, 100, 0), w, h), w, h, mx, my, 50)).toBe(true);
    expect(layerCovers(layerTransform(from, panBy(from, 150, 0), w, h), w, h, mx, my, 50)).toBe(false);
    // Rimpicciolito di 0,4 livelli con le dita al centro: coperto; con le dita sul bordo sinistro: il lato destro
    // si scopre prima.
    expect(layerCovers(layerTransform(from, zoomAround(from, 13.6, 160, 130, w, h), w, h), w, h, mx, my, 50)).toBe(true);
    expect(layerCovers(layerTransform(from, zoomAround(from, 13.6, 0, 130, w, h), w, h), w, h, mx, my, 50)).toBe(false);
  });

  it("fondo a bassa risoluzione: pochi tile, tre livelli sotto, coprono cinque volte il riquadro", async () => {
    const { backdropTiles } = await import("../lib/map-view.ts");
    const view = { center: [9.85, 44.04] as [number, number], zoom: 15.4 };
    const tiles = backdropTiles(view, 380, 380);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThanOrEqual(9);
    expect(new Set(tiles.map((t) => t.z))).toEqual(new Set([12]));
    expect(Math.min(...tiles.map((t) => t.left))).toBeLessThanOrEqual(-760);
    expect(Math.max(...tiles.map((t) => t.left + t.size))).toBeGreaterThanOrEqual(380 + 760);
    expect(Math.min(...tiles.map((t) => t.top))).toBeLessThanOrEqual(-760);
    expect(Math.max(...tiles.map((t) => t.top + t.size))).toBeGreaterThanOrEqual(380 + 760);
    expect(backdropTiles({ ...view, zoom: 2 }, 380, 380)).toEqual([]);
  });

  it("velocità al rilascio: solo gli ultimi istanti del dito", async () => {
    const { releaseVelocity } = await import("../lib/map-view.ts");
    expect(releaseVelocity([])).toEqual({ vx: 0, vy: 0 });
    expect(releaseVelocity([{ t: 0, x: 0, y: 0 }])).toEqual({ vx: 0, vy: 0 });
    // Movimento lento all'inizio, veloce alla fine: conta la fine.
    const v = releaseVelocity([{ t: 0, x: 0, y: 0 }, { t: 200, x: 10, y: 0 }, { t: 240, x: 50, y: 20 }, { t: 280, x: 90, y: 40 }]);
    expect(v.vx).toBeCloseTo(1, 6);
    expect(v.vy).toBeCloseTo(0.5, 6);
    // Dito fermo prima di alzarlo: nessuna inerzia.
    expect(releaseVelocity([{ t: 0, x: 0, y: 0 }, { t: 40, x: 50, y: 0 }, { t: 300, x: 50, y: 0 }])).toEqual({ vx: 0, vy: 0 });
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
