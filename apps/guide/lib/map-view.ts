/**
 * Geometria della mappa: proiezione Web Mercator (la stessa dei tile), inquadratura, tile da
 * caricare, scala grafica, posizionamento delle etichette senza sovrapposizioni.
 * Logica pura, testata; il componente MapView la usa per disegnare.
 */

export const TILE_SIZE = 256;
export const MIN_ZOOM = 3;
export const MAX_ZOOM = 19;

export type LngLat = readonly [number, number];
export interface Pixel {
  x: number;
  y: number;
}

/** Coordinate "mondo" in pixel allo zoom z (origine in alto a sinistra, come i tile). */
export function project([lng, lat]: LngLat, z: number): Pixel {
  const scale = TILE_SIZE * 2 ** z;
  const sin = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

export function unproject({ x, y }: Pixel, z: number): [number, number] {
  const scale = TILE_SIZE * 2 ** z;
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lng, lat];
}

/** Metri rappresentati da un pixel alla latitudine data. */
export function metersPerPixel(lat: number, z: number): number {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE * 2 ** z);
}

export interface MapViewState {
  center: LngLat;
  zoom: number;
}

/** Zoom intero più alto che fa stare tutti i punti nel riquadro (con margine in pixel). */
export function fitView(points: readonly LngLat[], width: number, height: number, padding = 32, maxZoom = 18): MapViewState {
  if (points.length === 0) return { center: [0, 0], zoom: MIN_ZOOM };
  const lngs = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  const box = { w: Math.min(...lngs), e: Math.max(...lngs), s: Math.min(...lats), n: Math.max(...lats) };
  for (let z = maxZoom; z > MIN_ZOOM; z--) {
    const a = project([box.w, box.n], z);
    const b = project([box.e, box.s], z);
    if (b.x - a.x <= width - 2 * padding && b.y - a.y <= height - 2 * padding) {
      return { center: unproject({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, z), zoom: z };
    }
  }
  const a = project([box.w, box.n], MIN_ZOOM);
  const b = project([box.e, box.s], MIN_ZOOM);
  return { center: unproject({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, MIN_ZOOM), zoom: MIN_ZOOM };
}

/** Converte un punto in coordinate dello schermo (pixel nel riquadro della mappa). */
export function toScreen(view: MapViewState, width: number, height: number) {
  const c = project(view.center, view.zoom);
  return (p: LngLat): Pixel => {
    const q = project(p, view.zoom);
    return { x: q.x - c.x + width / 2, y: q.y - c.y + height / 2 };
  };
}

/** Sposta il centro di (dx, dy) pixel dello schermo (trascinamento). */
export function panBy(view: MapViewState, dx: number, dy: number): MapViewState {
  const c = project(view.center, view.zoom);
  return { ...view, center: unproject({ x: c.x - dx, y: c.y - dy }, view.zoom) };
}

export interface TilePlacement {
  key: string;
  x: number;
  y: number;
  z: number;
  left: number;
  top: number;
}

/** Tile che coprono il riquadro, con la loro posizione sullo schermo. */
export function visibleTiles(view: MapViewState, width: number, height: number): TilePlacement[] {
  const z = Math.round(view.zoom);
  const c = project(view.center, z);
  const x0 = c.x - width / 2;
  const y0 = c.y - height / 2;
  const n = 2 ** z;
  const tiles: TilePlacement[] = [];
  for (let tx = Math.floor(x0 / TILE_SIZE); tx <= Math.floor((x0 + width) / TILE_SIZE); tx++) {
    for (let ty = Math.floor(y0 / TILE_SIZE); ty <= Math.floor((y0 + height) / TILE_SIZE); ty++) {
      if (ty < 0 || ty >= n) continue;
      const wx = ((tx % n) + n) % n;
      tiles.push({ key: `${z}/${wx}/${ty}`, x: wx, y: ty, z, left: tx * TILE_SIZE - x0, top: ty * TILE_SIZE - y0 });
    }
  }
  return tiles;
}

/** Scala grafica "tonda" (1, 2, 5 × 10ⁿ metri) lunga al massimo maxPx pixel. */
export function scaleBar(lat: number, zoom: number, maxPx = 90): { meters: number; px: number; label: string } {
  const mpp = metersPerPixel(lat, zoom);
  const max = mpp * maxPx;
  const pow = 10 ** Math.floor(Math.log10(max));
  const meters = [5, 2, 1].map((k) => k * pow).find((m) => m <= max) ?? pow;
  return { meters, px: meters / mpp, label: meters >= 1000 ? `${meters / 1000} km` : `${meters} m` };
}

export interface LabelCandidate {
  id: string;
  x: number;
  y: number;
  text: string;
  /** Più alto = disegnata per prima, e quindi mai nascosta da etichette meno importanti. */
  priority: number;
  /** Raggio del simbolo, per staccare il testo. */
  offset: number;
}

export interface PlacedLabel {
  id: string;
  x: number;
  y: number;
  anchor: "start" | "end";
  text: string;
}

/**
 * Etichette senza sovrapposizioni: in ordine di priorità, a destra del punto o, se non c'è posto,
 * a sinistra; se non c'è posto da nessuna parte l'etichetta non si disegna (il punto resta).
 */
export function placeLabels(candidates: LabelCandidate[], width: number, height: number, charW = 5.6, lineH = 12): PlacedLabel[] {
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const placed: PlacedLabel[] = [];
  const overlaps = (b: (typeof boxes)[number]) =>
    b.x0 < 0 || b.x1 > width || b.y0 < 0 || b.y1 > height || boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
  for (const c of [...candidates].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
    const w = c.text.length * charW;
    const y0 = c.y - lineH / 2;
    const right = { x0: c.x + c.offset + 3, y0, x1: c.x + c.offset + 3 + w, y1: y0 + lineH };
    const left = { x0: c.x - c.offset - 3 - w, y0, x1: c.x - c.offset - 3, y1: y0 + lineH };
    if (!overlaps(right)) {
      boxes.push(right);
      placed.push({ id: c.id, x: right.x0, y: c.y + 4, anchor: "start", text: c.text });
    } else if (!overlaps(left)) {
      boxes.push(left);
      placed.push({ id: c.id, x: left.x1, y: c.y + 4, anchor: "end", text: c.text });
    }
  }
  return placed;
}
