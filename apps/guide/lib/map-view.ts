/**
 * Geometria della mappa: proiezione Web Mercator (la stessa dei tile e di MapLibre), inquadratura, scala grafica,
 * posizionamento delle etichette senza sovrapposizioni, sfondo (fornitore dei tile) e conversione dello zoom per
 * MapLibre, che disegna sfondo e gesti.
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
/**
 * Zoom (della guida) da cui compaiono i sottoluoghi: più lontano la mappa mostra solo i luoghi principali, per non
 * affollarsi; avvicinandosi compaiono anche i luoghi che ne fanno parte (`partOf`).
 */
export const SUB_PLACE_MIN_ZOOM = 16.5;

/** È un sottoluogo: fa parte di un altro luogo presente nello stesso elenco. */
export function isSubPlace(p: { ref: string; partOf?: string }, refs: ReadonlySet<string>): boolean {
  return !!p.partOf && p.partOf !== p.ref && refs.has(p.partOf);
}

/**
 * Luoghi da disegnare sulla mappa allo zoom dato. Sotto SUB_PLACE_MIN_ZOOM i principali; da lì in su i sottoluoghi
 * prendono il posto del loro principale, che sparisce (i principali senza sottoluoghi restano). Quelli in `keep`
 * (il luogo selezionato, quello dove si è) restano a ogni zoom.
 */
export function placesOnMap<P extends { ref: string; partOf?: string }>(places: readonly P[], zoom: number, keep: ReadonlySet<string> = new Set()): P[] {
  const refs = new Set(places.map((p) => p.ref));
  const near = zoom >= SUB_PLACE_MIN_ZOOM;
  const parents = new Set(places.filter((p) => isSubPlace(p, refs)).map((p) => p.partOf as string));
  return places.filter((p) => keep.has(p.ref) || (near ? !parents.has(p.ref) : !isSubPlace(p, refs)));
}

export const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

/** Qualcosa da toccare sulla mappa: un cerchio (spillo, tappa, attività) o un rettangolo (nome del luogo). */
export type HitTarget =
  | { id: string; kind: "place" | "venue"; x: number; y: number; r: number }
  | { id: string; kind: "place" | "venue"; box: { x0: number; y0: number; x1: number; y1: number } };

/**
 * Cosa c'è sotto il dito. Tutti i tocchi vanno alla mappa (così un pizzico che parte da uno spillo o da un nome
 * resta un pizzico); quando la mappa riconosce un tocco semplice si cerca qui il simbolo più vicino entro il suo
 * raggio, poi un nome che contenga il punto. Null: nessuno.
 */
export function hitTarget(p: Pixel, targets: readonly HitTarget[]): { id: string; kind: "place" | "venue" } | null {
  let best: { id: string; kind: "place" | "venue"; d: number } | null = null;
  for (const t of targets) {
    if (!("r" in t)) continue;
    const d = Math.hypot(p.x - t.x, p.y - t.y);
    if (d <= t.r && (!best || d < best.d)) best = { id: t.id, kind: t.kind, d };
  }
  if (best) return { id: best.id, kind: best.kind };
  for (const t of targets) {
    if ("box" in t && p.x >= t.box.x0 && p.x <= t.box.x1 && p.y >= t.box.y0 && p.y <= t.box.y1) return { id: t.id, kind: t.kind };
  }
  return null;
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

/**
 * MapLibre misura lo zoom in tile da 512 px, questa libreria (e le coordinate di project/toScreen) in tile da 256:
 * lo stesso ingrandimento è un livello in meno per MapLibre.
 */
export const toGlZoom = (zoom: number) => zoom - 1;
export const fromGlZoom = (glZoom: number) => glZoom + 1;

/** Modello dei tile per MapLibre: {z}, {x} e {y} restano (li riempie MapLibre), {r} si risolve qui. */
export function rasterTemplate(source: TileSource, pixelRatio = 1): string {
  return source.template.replaceAll("{r}", pixelRatio > 1 ? "@2x" : "");
}
