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

/** Zoom dentro i limiti della mappa (anche frazionario: lo zoom con le dita è continuo). */
export const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

/**
 * Cambia lo zoom tenendo fermo il punto della mappa che sta sotto (px, py) dello schermo: il punto tra le dita del
 * pizzico, il cursore con la rotella, il dito del doppio tocco.
 */
export function zoomAround(view: MapViewState, zoom: number, px: number, py: number, width: number, height: number): MapViewState {
  const z = clampZoom(zoom);
  const dx = px - width / 2;
  const dy = py - height / 2;
  const c0 = project(view.center, view.zoom);
  const under = unproject({ x: c0.x + dx, y: c0.y + dy }, view.zoom);
  const p1 = project(under, z);
  return { center: unproject({ x: p1.x - dx, y: p1.y - dy }, z), zoom: z };
}

/** Zoom del pizzico: continuo, proporzionale a quanto si allargano o stringono le dita rispetto all'inizio. */
export function pinchZoom(startZoom: number, startDistance: number, distance: number): number {
  if (startDistance <= 0 || distance <= 0) return clampZoom(startZoom);
  return clampZoom(startZoom + Math.log2(distance / startDistance));
}

export interface TilePlacement {
  key: string;
  x: number;
  y: number;
  z: number;
  left: number;
  top: number;
  /** Lato sullo schermo: 256 px a zoom intero, ingrandito o ridotto tra un livello e l'altro. */
  size: number;
}

/** Come arrotondare le posizioni: densità dello schermo e posizione del riquadro nella pagina, in pixel CSS. */
export interface PixelGrid {
  /** Pixel fisici per pixel CSS (2,625 su molti Android). */
  ratio: number;
  /** Posizione del riquadro della mappa nella pagina (può cadere a metà di un pixel fisico, per esempio 438,94). */
  originX: number;
  originY: number;
}
const NO_GRID: PixelGrid = { ratio: 1, originX: 0, originY: 0 };

/**
 * Tile che coprono il riquadro, con la loro posizione sullo schermo. A zoom frazionario si usano i tile del livello
 * più vicino (o di `level`, se indicato), scalati: i bordi cadono sui pixel fisici della pagina (`grid`: densità e
 * posizione del riquadro) e sono contigui, senza fessure. Un bordo a metà di un pixel fisico verrebbe sfumato dal
 * browser e si vedrebbe come una riga sottile.
 */
export function visibleTiles(view: MapViewState, width: number, height: number, level?: number, grid: PixelGrid = NO_GRID): TilePlacement[] {
  const z = Math.max(0, Math.min(MAX_ZOOM, level ?? Math.round(view.zoom)));
  const s = 2 ** (view.zoom - z);
  const c = project(view.center, z);
  const x0 = c.x - width / 2 / s;
  const y0 = c.y - height / 2 / s;
  const x1 = c.x + width / 2 / s;
  const y1 = c.y + height / 2 / s;
  const n = 2 ** z;
  const r = grid.ratio > 0 && Number.isFinite(grid.ratio) ? grid.ratio : 1;
  const ox = Number.isFinite(grid.originX) ? grid.originX : 0;
  const oy = Number.isFinite(grid.originY) ? grid.originY : 0;
  // Si arrotonda la posizione nella pagina, non quella nel riquadro: è la pagina a stare sulla griglia dei pixel fisici.
  const sx = (wx: number) => Math.round(((wx - x0) * s + ox) * r) / r - ox;
  const sy = (wy: number) => Math.round(((wy - y0) * s + oy) * r) / r - oy;
  const tiles: TilePlacement[] = [];
  for (let tx = Math.floor(x0 / TILE_SIZE); tx <= Math.floor(x1 / TILE_SIZE); tx++) {
    for (let ty = Math.floor(y0 / TILE_SIZE); ty <= Math.floor(y1 / TILE_SIZE); ty++) {
      if (ty < 0 || ty >= n) continue;
      const wx = ((tx % n) + n) % n;
      const left = sx(tx * TILE_SIZE);
      const top = sy(ty * TILE_SIZE);
      tiles.push({ key: `${z}/${wx}/${ty}`, x: wx, y: ty, z, left, top, size: sx((tx + 1) * TILE_SIZE) - left });
    }
  }
  return tiles;
}

/**
 * Trasformazione CSS (traslazione, poi scala, origine in alto a sinistra) che porta ciò che è disegnato per
 * l'inquadratura `from` dove starebbe con l'inquadratura `to`. Durante un gesto lo sfondo non si ridisegna: si
 * sposta e si ingrandisce tutto insieme con la scheda grafica, e si ridisegna nitido solo a gesto finito.
 */
export function layerTransform(from: MapViewState, to: MapViewState, width: number, height: number): { x: number; y: number; scale: number } {
  const scale = 2 ** (to.zoom - from.zoom);
  const a = project(from.center, to.zoom);
  const b = project(to.center, to.zoom);
  return { x: a.x - b.x + (width / 2) * (1 - scale), y: a.y - b.y + (height / 2) * (1 - scale), scale };
}

/**
 * Vero se lo strato disegnato per un'inquadratura (riquadro più un margine `marginX`/`marginY` per lato, in pixel),
 * spostato con la trasformazione `t`, copre ancora tutto il riquadro con almeno `slack` pixel di scorta per lato.
 * Quando non è più vero si ridisegna lo sfondo, prima che compaia una fascia vuota.
 */
export function layerCovers(
  t: { x: number; y: number; scale: number },
  width: number,
  height: number,
  marginX: number,
  marginY: number,
  slack = 0,
): boolean {
  const left = t.x - t.scale * marginX;
  const right = t.x + t.scale * (width + marginX);
  const top = t.y - t.scale * marginY;
  const bottom = t.y + t.scale * (height + marginY);
  return left <= -slack && top <= -slack && right >= width + slack && bottom >= height + slack;
}

/** Velocità di un trascinamento (px/ms) dagli ultimi campioni del dito, solo quelli degli ultimi `windowMs`. */
export function releaseVelocity(samples: readonly { t: number; x: number; y: number }[], windowMs = 90): { vx: number; vy: number } {
  if (samples.length < 2) return { vx: 0, vy: 0 };
  const last = samples[samples.length - 1]!;
  const recent = samples.filter((s) => last.t - s.t <= windowMs);
  const first = recent[0]!;
  const dt = last.t - first.t;
  if (recent.length < 2 || dt <= 0) return { vx: 0, vy: 0 };
  return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
}

/**
 * Fondo a bassa risoluzione, sotto tutti gli altri strati: tile di `levelsBelow` livelli più in basso che coprono
 * `spread` volte il riquadro per lato. Sono pochi (4-9) e già scaricati prima di un gesto: rimpicciolendo in fretta,
 * dove i tile nuovi non sono ancora arrivati si vede la mappa sfocata invece di una fascia vuota.
 */
export function backdropTiles(view: MapViewState, width: number, height: number, grid: PixelGrid = NO_GRID, levelsBelow = 3, spread = 2): TilePlacement[] {
  const level = Math.round(view.zoom) - levelsBelow;
  if (level < 0) return [];
  const bw = Math.round(width * spread);
  const bh = Math.round(height * spread);
  return visibleTiles(view, width + 2 * bw, height + 2 * bh, level, { ...grid, originX: grid.originX - bw, originY: grid.originY - bh })
    .map((t) => ({ ...t, left: t.left - bw, top: t.top - bh }));
}

/**
 * Sfondo in due strati: sotto il livello precedente (pochi tile, quasi sempre già scaricati), sopra quello giusto.
 * Mentre si ingrandisce, i tile nuovi compaiono sopra un'immagine già presente invece che su un riquadro vuoto.
 */
export function tileLayers(view: MapViewState, width: number, height: number, grid: PixelGrid = NO_GRID): TilePlacement[] {
  const z = Math.round(view.zoom);
  return [...(z > 0 ? visibleTiles(view, width, height, z - 1, grid) : []), ...visibleTiles(view, width, height, z, grid)];
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
  // I simboli di tutti i punti sono ostacoli: un'etichetta sopra il simbolo di un altro luogo inganna.
  const markers = candidates.map((c) => ({ id: c.id, x0: c.x - c.offset, y0: c.y - c.offset, x1: c.x + c.offset, y1: c.y + c.offset }));
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const placed: PlacedLabel[] = [];
  const hit = (b: (typeof boxes)[number], o: (typeof boxes)[number]) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0;
  let current = "";
  const overlaps = (b: (typeof boxes)[number]) =>
    b.x0 < 0 ||
    b.x1 > width ||
    b.y0 < 0 ||
    b.y1 > height ||
    boxes.some((o) => hit(b, o)) ||
    markers.some((m) => m.id !== current && hit(b, m));
  for (const c of [...candidates].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
    current = c.id;
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

/**
 * Sfondo della mappa. Per le prove si usano i tile di OpenStreetMap; in produzione serve un fornitore con licenza
 * adeguata e uno stile personalizzato senza attività commerciali (bar, ristoranti, negozi: la guida mostra le sue,
 * dallo Studio) ma con chiese, monumenti e servizi. Si sceglie al build con NEXT_PUBLIC_MAP_TILES_URL (modello con
 * {z}, {x}, {y} e, facoltativo, {r} per «@2x» sugli schermi ad alta densità) e NEXT_PUBLIC_MAP_TILES_ATTRIBUTION
 * (testo, senza link). La chiave nel modello è pubblica per natura: va limitata ai domini dell'app dal fornitore.
 * Tile da 256 px, come quelli di OpenStreetMap.
 */
export interface TileSource {
  template: string;
  attribution: string;
}

export const OSM_TILES: TileSource = { template: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "© OpenStreetMap" };

/** Modello valido: https, con {z}, {x} e {y}, senza spazi né caratteri di controllo, al massimo 500 caratteri. */
export function tileSourceFrom(template: string | undefined, attribution: string | undefined): TileSource {
  const t = (template ?? "").trim();
  const ok = t.length > 0 && t.length <= 500 && /^https:\/\/[^\s/]+\//.test(t) && !/[\s\u0000-\u001f]/.test(t)
    && t.includes("{z}") && t.includes("{x}") && t.includes("{y}");
  if (!ok) return OSM_TILES;
  const a = (attribution ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 200);
  return { template: t, attribution: a || "© OpenStreetMap" };
}

/** Indirizzo di un tile; `{r}` diventa «@2x» se lo schermo ha più di un pixel per punto. */
export function tileUrl(source: TileSource, z: number, x: number, y: number, pixelRatio = 1): string {
  return source.template
    .replaceAll("{z}", String(z))
    .replaceAll("{x}", String(x))
    .replaceAll("{y}", String(y))
    .replaceAll("{r}", pixelRatio > 1 ? "@2x" : "");
}
