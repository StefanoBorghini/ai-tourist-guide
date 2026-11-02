"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Map as GlMap, StyleSpecification } from "maplibre-gl";
import type { BundleContent } from "@guide/bundle/client";
import { distanceM } from "@guide/context-engine";
import type { UiText } from "../lib/i18n";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  fitView,
  fromGlZoom,
  hitTarget,
  metersPerPixel,
  panBy,
  placeLabels,
  rasterTemplate,
  scaleBar,
  tileSourceFrom,
  toGlZoom,
  toScreen,
  type HitTarget,
  type LabelCandidate,
  type LngLat,
  type MapViewState,
} from "../lib/map-view";
import type { GuideRuntime } from "../lib/runtime";

/**
 * Mappa del giro: sfondo e gesti (trascinamento con inerzia, pizzico, rotella, doppio tocco) con MapLibre GL, che
 * disegna con la scheda grafica; sopra, in SVG, ciò che è della guida: tappe numerate nell'ordine del piano, spilli
 * dei luoghi, etichette senza sovrapposizioni, posizione con la sua precisione, geofence in modalità debug. Le
 * posizioni provvisorie sono tratteggiate: non vanno prese per buone. Senza rete (o senza WebGL) resta la mappa
 * schematica, con trascinamento e pulsanti.
 *
 * In esplorazione non ci sono tappe: tutti i luoghi sono spilli, la mappa segue il visitatore
 * (punto blu, inconfondibile con gli spilli) finché non la sposta, e «Centra su di me» la riaggancia.
 *
 * Livello «Locali e attività» (`layer="venues"`): la stessa mappa mostra solo le attività della directory (segni
 * quadrati, diversi dagli spilli dei luoghi) e nasconde luoghi e ancore. Cambiando livello il componente non si
 * ricrea: inquadratura, zoom, GPS e controlli restano come sono.
 */
const HEIGHT = 260;
/**
 * Mappa in esplorazione: è lo strumento principale, quadrata (decisione del 2026-10-19). Su schermi larghi
 * l'altezza si ferma a 560 px per non spingere giù il resto.
 */
const TALL_STYLE = { aspectRatio: "1 / 1", maxHeight: 560 } as const;
/** Zoom quando la mappa segue il visitatore: si vedono i luoghi nel raggio di qualche centinaio di metri. */
const FOLLOW_ZOOM = 17;
/** Spillo con la punta nel punto (0,0): alto 20 px. */
const PIN_PATH = "M0,0 C-1.5,-5 -7,-8 -7,-13 A7,7 0 1,1 7,-13 C7,-8 1.5,-5 0,0 Z";
const PIN_HEAD_Y = -13;
/** Spostamento minimo (px) perché un tocco diventi un trascinamento (mappa schematica, senza MapLibre). */
const DRAG_THRESHOLD = 6;
/** Oltre questa distanza dalle tappe la posizione non entra nell'inquadratura del percorso (es. prove da casa). */
const NEAR_ROUTE_M = 2000;
/** Sfondo scelto al build (lib/map-view.ts): OpenStreetMap per le prove, uno stile con licenza in produzione. */
const TILES = tileSourceFrom(process.env.NEXT_PUBLIC_MAP_TILES_URL, process.env.NEXT_PUBLIC_MAP_TILES_ATTRIBUTION);
/** Colore della terra delle mappe: dove un tile non è ancora arrivato non si vede un buco nero. */
const LAND = "#f2efe9";

type Mode = "route" | "me" | "all";

/** Attività sulla mappa (directory gratuita): solo quelle con coordinate. */
export interface MapVenue {
  id: string;
  name: string;
  location: LngLat;
  category: string;
}

/** Stile MapLibre: solo il fondo color terra e i tile raster del fornitore scelto (nessun testo né icona di MapLibre). */
function glStyle(pixelRatio: number): StyleSpecification {
  return {
    version: 8,
    sources: {
      base: { type: "raster", tiles: [rasterTemplate(TILES, pixelRatio)], tileSize: 256, maxzoom: 19 },
    },
    layers: [
      { id: "land", type: "background", paint: { "background-color": LAND } },
      { id: "base", type: "raster", source: "base", paint: { "raster-fade-duration": 0 } },
    ],
  };
}

export function MapView(props: {
  content: BundleContent;
  runtime: GuideRuntime;
  debug: boolean;
  online: boolean;
  simulated: boolean;
  t: UiText;
  /** Luogo selezionato, gestito dal genitore (scheda del luogo). Senza, la mappa mostra una riga di info. */
  selected?: string | null;
  onSelect?: (ref: string | null) => void;
  tall?: boolean;
  /** Luoghi a pagamento non ancora acquistati: non compaiono sulla mappa (restano nell'elenco, con «Sblocca»). */
  locked?: ReadonlySet<string>;
  /** Cosa mostra la mappa: i luoghi del territorio (predefinito) o le attività della directory. */
  layer?: "places" | "venues";
  venues?: readonly MapVenue[];
  selectedVenue?: string | null;
  onSelectVenue?: (id: string | null) => void;
  /**
   * «Mostra sulla mappa» di un'attività: sul livello dei luoghi (percorsi guidati) compare solo lei, evidenziata;
   * toccarla la toglie (onSelectVenue(null)).
   */
  pinnedVenue?: MapVenue | null;
  /** Centra la mappa su un punto; un nuovo `id` ricentra anche sullo stesso punto. */
  focus?: { id: number; location: LngLat } | null;
}) {
  const { content, runtime, debug, online, simulated, t } = props;
  const explore = runtime.kind === "explore";
  const venuesLayer = props.layer === "venues";
  const venues = venuesLayer ? (props.venues ?? []) : props.pinnedVenue ? [props.pinnedVenue] : [];
  const selectedVenue = venuesLayer ? (props.selectedVenue ?? null) : (props.pinnedVenue?.id ?? null);
  const boxRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<GlMap | null>(null);
  const [width, setWidth] = useState(320);
  const [measuredHeight, setMeasuredHeight] = useState(HEIGHT);
  const [fullscreen, setFullscreen] = useState(false);
  const [mode, setMode] = useState<Mode>(explore ? "me" : "route");
  /** Inquadratura scelta a mano (trascinando, ingrandendo); null: la mappa segue l'inquadratura automatica. */
  const [manual, setManual] = useState<MapViewState | null>(null);
  /** Inquadratura di MapLibre, letta a ogni fotogramma del movimento: gli strati SVG la seguono. */
  const [cam, setCam] = useState<MapViewState | null>(null);
  /** MapLibre pronto; false se il dispositivo non ha WebGL (si usa la mappa schematica). */
  const [gl, setGl] = useState<"loading" | "ready" | "unavailable">("loading");
  const [ownSelected, setOwnSelected] = useState<string | null>(null);
  const controlled = props.onSelect !== undefined;
  const selected = controlled ? (props.selected ?? null) : ownSelected;
  const setSelected = (ref: string | null) => (controlled ? props.onSelect!(ref) : setOwnSelected(ref));
  const [basemap, setBasemap] = useState(true);
  const [tilesOk, setTilesOk] = useState(false);
  const [tileErrors, setTileErrors] = useState(0);
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);
  /** Un tocco che ha spostato la mappa non seleziona lo spillo su cui è finito. */
  const movedAt = useRef(0);
  /** Simboli e nomi toccabili, con la loro posizione di adesso, e cosa fare quando se ne tocca uno. */
  const hitsRef = useRef<HitTarget[]>([]);
  const onHitRef = useRef<(hit: { id: string; kind: "place" | "venue" }) => void>(() => undefined);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setWidth(Math.max(200, Math.round(entry!.contentRect.width)));
      setMeasuredHeight(Math.max(200, Math.round(entry!.contentRect.height)));
      mapRef.current?.resize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fullscreen]);

  // MapLibre si carica solo nel browser (usa WebGL) e solo quando serve la mappa.
  useEffect(() => {
    let cancelled = false;
    let map: GlMap | null = null;
    (async () => {
      try {
        const maplibre = await import("maplibre-gl");
        if (cancelled || !glRef.current) return;
        // Il worker di MapLibre lo copia in public/vendor/ lo script di build (scripts/copy-vendor.mjs).
        maplibre.setWorkerUrl(`/vendor/maplibre-gl-worker.mjs?v=${maplibre.getVersion()}`);
        const created = new maplibre.Map({
          container: glRef.current,
          style: glStyle(window.devicePixelRatio || 1),
          center: [0, 0],
          zoom: 1,
          minZoom: toGlZoom(MIN_ZOOM),
          maxZoom: toGlZoom(MAX_ZOOM),
          attributionControl: false,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          maxPitch: 0,
          renderWorldCopies: true,
          fadeDuration: 0,
        });
        map = created;
        created.touchZoomRotate.disableRotation();
        created.keyboard.disableRotation();
        const read = () => {
          const c = created.getCenter();
          return { center: [c.lng, c.lat] as LngLat, zoom: fromGlZoom(created.getZoom()) };
        };
        created.on("move", () => setCam(read()));
        // Movimento fatto dal visitatore (dita, rotella, tastiera): la mappa smette di seguire l'inquadratura automatica.
        created.on("movestart", (e) => {
          if ((e as { originalEvent?: Event }).originalEvent) {
            movedAt.current = performance.now();
            setManual(read());
          }
        });
        created.on("moveend", (e) => {
          if ((e as { originalEvent?: Event }).originalEvent) movedAt.current = performance.now();
        });
        created.on("data", (e) => {
          if ((e as { dataType?: string; tile?: unknown }).dataType === "source" && (e as { tile?: unknown }).tile) setTilesOk(true);
        });
        created.on("error", () => setTileErrors((n) => n + 1));
        // Tocco semplice riconosciuto dalla mappa (non un trascinamento né un pizzico): cosa c'è sotto il dito.
        created.on("click", (e) => {
          const hit = hitTarget({ x: e.point.x, y: e.point.y }, hitsRef.current);
          if (hit) onHitRef.current(hit);
        });
        mapRef.current = created;
        // Modalità debug (?debug=1): la mappa si può ispezionare dalla console e dalle prove automatiche.
        if (new URLSearchParams(window.location.search).has("debug")) (window as unknown as { __guideMap?: GlMap }).__guideMap = created;
        setCam(read());
        setGl("ready");
      } catch {
        if (!cancelled) setGl("unavailable");
      }
    })();
    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // «Mostra sulla mappa»: inquadratura ferma sul punto (come uno spostamento a mano), abbastanza vicina da riconoscerlo.
  const focusId = props.focus?.id;
  useEffect(() => {
    if (!props.focus) return;
    const target = { center: props.focus.location, zoom: Math.max(FOLLOW_ZOOM + 1, Math.min(MAX_ZOOM, 18)) };
    setManual(target);
    mapRef.current?.easeTo({ center: [...target.center] as [number, number], zoom: toGlZoom(target.zoom), duration: 400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- si ricentra solo a una nuova richiesta
  }, [focusId]);

  // Passando da un itinerario all'esplorazione la mappa torna a seguire il visitatore.
  useEffect(() => {
    setMode(explore ? "me" : "route");
    setManual(null);
  }, [explore]);

  // A schermo intero: niente scorrimento della pagina sotto, Esc o «indietro» del telefono chiudono.
  useEffect(() => {
    if (!fullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFullscreen(false);
    const onPop = () => setFullscreen(false);
    window.addEventListener("keydown", onKey);
    window.history.pushState({ mapFullscreen: true }, "");
    window.addEventListener("popstate", onPop);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPop);
      if (window.history.state?.mapFullscreen) window.history.back();
    };
  }, [fullscreen]);

  const fix = runtime.lastFix;
  const mapHeight = fullscreen || props.tall ? measuredHeight : HEIGHT;
  const placeByRef = useMemo(() => new Map(content.places.map((p) => [p.ref, p])), [content]);
  const stops = (runtime.plan?.stops ?? []).map((s) => placeByRef.get(s.placeId)).filter((p): p is NonNullable<typeof p> => !!p);
  const stopIndex = new Map(stops.map((p, i) => [p.ref, i]));
  const next = runtime.nextStop;

  // Inquadratura automatica, finché l'utente non sposta o ingrandisce la mappa.
  const auto = (): MapViewState => {
    if (mode === "me" && fix) return { center: fix.location, zoom: explore ? FOLLOW_ZOOM : 18 };
    if (mode === "all") {
      // «Tutti»: le attività del livello, se ce ne sono; altrimenti i luoghi (la mappa non resta vuota).
      if (venuesLayer && venues.length > 0) return fitView(venues.map((v) => v.location), width, mapHeight);
      return fitView([...content.places.map((p) => p.location), ...content.anchors.map((a) => a.location)], width, mapHeight);
    }
    const pts: LngLat[] = stops.length > 0 ? stops.map((p) => p.location) : content.places.map((p) => p.location);
    if (fix && pts.some((p) => distanceM(p, fix.location) < NEAR_ROUTE_M)) pts.push(fix.location);
    return fitView(pts, width, mapHeight);
  };
  const target = manual ?? auto();
  const targetKey = manual ? "" : `${target.center[0].toFixed(6)},${target.center[1].toFixed(6)},${target.zoom.toFixed(3)}`;
  const firstJump = useRef(true);
  // Inquadratura automatica → MapLibre: la prima volta di colpo, poi con un breve movimento (segue il GPS).
  useEffect(() => {
    const map = mapRef.current;
    if (gl !== "ready" || !map) return;
    if (manual) {
      // Inquadratura scelta prima che MapLibre fosse pronto (es. «Mostra sulla mappa»): ci si va subito.
      if (firstJump.current) {
        firstJump.current = false;
        map.jumpTo({ center: [...manual.center] as [number, number], zoom: toGlZoom(manual.zoom) });
      }
      return;
    }
    const opts = { center: [...target.center] as [number, number], zoom: toGlZoom(target.zoom) };
    if (firstJump.current) {
      firstJump.current = false;
      map.jumpTo(opts);
    } else {
      map.easeTo({ ...opts, duration: 350 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- si muove solo quando cambia l'inquadratura automatica
  }, [gl, targetKey, manual === null]);

  // Con MapLibre gli strati SVG seguono la sua telecamera; senza, l'inquadratura scelta (schematica).
  const view = gl === "ready" && cam ? cam : target;
  const screen = toScreen(view, width, mapHeight);
  const mpp = metersPerPixel(view.center[1], view.zoom);
  const showTiles = online && basemap && gl === "ready";
  useEffect(() => {
    const map = mapRef.current;
    if (gl !== "ready" || !map) return;
    const apply = () => {
      map.setLayoutProperty("base", "visibility", showTiles ? "visible" : "none");
      map.setLayoutProperty("land", "visibility", showTiles ? "visible" : "none");
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [gl, showTiles]);
  const scale = scaleBar(view.center[1], view.zoom);
  const fences = runtime.debugSnapshot().places;
  // Tratteggiate solo le posizioni non verificate nemmeno su mappa (preliminari o da rivedere).
  const unverified = (status: string) => status === "preliminary" || status === "needs_review";
  const preliminary = content.places.some((p) => unverified(p.coordinateStatus));
  const notFieldVerified = content.places.some((p) => p.coordinateStatus === "map_verified");

  const venueLabels: LabelCandidate[] = venues.map((v) => {
    const s = screen(v.location);
    return { id: v.id, x: s.x, y: s.y, text: v.name, priority: v.id === selectedVenue ? 110 : 50, offset: 10 };
  });
  const labelCandidates: LabelCandidate[] = venuesLayer ? venueLabels : [
    ...venueLabels,
    // Come gli spilli: niente nome per i luoghi a pagamento non acquistati (le tappe restano).
    ...content.places.filter((p) => stopIndex.has(p.ref) || !props.locked?.has(p.ref)).map((p) => {
      const s = screen(p.location);
      const i = stopIndex.get(p.ref);
      const priority =
        p.ref === selected ? 110 : p.ref === next ? 100 : p.ref === runtime.currentPlaceRef ? 95 : i !== undefined ? 80 - i : p.importance * 5;
      // Gli spilli stanno sopra il punto: l'etichetta si allinea alla testa dello spillo.
      return i !== undefined
        ? { id: p.ref, x: s.x, y: s.y, text: p.name, priority, offset: 11 }
        : { id: p.ref, x: s.x, y: s.y + PIN_HEAD_Y, text: p.name, priority, offset: 8 };
    }),
    ...content.anchors.map((a) => ({ id: a.ref, ...screen(a.location), text: a.name, priority: 40, offset: 7 })),
  ];
  const labels = placeLabels(labelCandidates, width, mapHeight);

  const zoomBy = (d: number) => {
    const map = mapRef.current;
    if (gl === "ready" && map) {
      setManual(view);
      map.easeTo({ zoom: Math.round(map.getZoom()) + d, duration: 250 });
    } else {
      setManual({ ...view, zoom: clampZoom(Math.round(view.zoom) + d) });
    }
  };
  const choose = (m: Mode) => {
    setMode(m);
    setManual(null);
  };

  // Mappa schematica (senza WebGL): trascinamento con un dito; lo zoom si fa con i pulsanti.
  const onPointerDown = (e: ReactPointerEvent) => {
    if (gl === "ready") return;
    drag.current = { x: e.clientX, y: e.clientY, moved: 0 };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (gl === "ready" || !d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.moved += Math.abs(dx) + Math.abs(dy);
    d.x = e.clientX;
    d.y = e.clientY;
    if (d.moved > DRAG_THRESHOLD) {
      const el = e.currentTarget as HTMLElement;
      if (!el.hasPointerCapture(e.pointerId)) el.setPointerCapture(e.pointerId);
      movedAt.current = performance.now();
      setManual(panBy(view, dx, dy));
    }
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  /** Vero subito dopo un trascinamento o un pizzico: il dito alzato non è una scelta. */
  const justMoved = () => performance.now() - movedAt.current < 250;
  const select = (ref: string) => {
    if (justMoved()) return;
    setSelected(selected === ref ? null : ref);
  };
  const venueIds = new Set(venues.map((v) => v.id));
  const selectVenue = (id: string) => {
    if (justMoved()) return;
    props.onSelectVenue?.(selectedVenue === id ? null : id);
  };
  // Con MapLibre i tocchi arrivano tutti alla mappa; i simboli si riconoscono qui, dalla loro posizione.
  hitsRef.current = [
    ...(!venuesLayer
      ? content.places
          .filter((p) => !stopIndex.has(p.ref) && !props.locked?.has(p.ref))
          .map((p) => { const s = screen(p.location); return { id: p.ref, kind: "place" as const, x: s.x, y: s.y + PIN_HEAD_Y + 2, r: 18 }; })
      : []),
    ...(!venuesLayer ? stops.map((p) => { const s = screen(p.location); return { id: p.ref, kind: "place" as const, x: s.x, y: s.y, r: 16 }; }) : []),
    ...venues.map((v) => { const s = screen(v.location); return { id: v.id, kind: "venue" as const, x: s.x, y: s.y, r: 18 }; }),
    ...labels
      .filter((l) => placeByRef.has(l.id) || venueIds.has(l.id))
      .map((l) => {
        const w = l.text.length * 5.6;
        const x0 = l.anchor === "start" ? l.x : l.x - w;
        return { id: l.id, kind: venueIds.has(l.id) ? ("venue" as const) : ("place" as const), box: { x0: x0 - 4, y0: l.y - 14, x1: x0 + w + 4, y1: l.y + 4 } };
      }),
  ];
  onHitRef.current = (hit) => (hit.kind === "venue" ? props.onSelectVenue?.(selectedVenue === hit.id ? null : hit.id) : setSelected(selected === hit.id ? null : hit.id));
  const modes: Mode[] = explore ? ["me", "all"] : ["route", "me", "all"];
  const following = mode === "me" && !manual && !!fix;

  const sel = selected ? placeByRef.get(selected) : undefined;
  const me = fix ? screen(fix.location) : null;

  return (
    <section className={`${fullscreen ? "mapview fullscreen" : "card mapview"}${venuesLayer ? " layer-venues" : ""}`}>
      <div className="row wrap map-modes">
        {modes.map((m) => (
          <button key={m} className={`chip small ${mode === m && !manual ? "on" : ""}`} onClick={() => choose(m)} disabled={m === "me" && !fix}>
            {m === "all" && venuesLayer ? t.map.allVenues : t.map[m]}
          </button>
        ))}
      </div>
      <div
        ref={boxRef}
        className={showTiles ? "map-box with-tiles" : "map-box"}
        style={fullscreen ? undefined : props.tall ? TALL_STYLE : { height: HEIGHT }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* Sfondo e gesti: MapLibre (scheda grafica). */}
        <div ref={glRef} className="map-gl" aria-hidden="true" />
        {/* Ciò che è della guida, sopra: segue la telecamera di MapLibre a ogni fotogramma. Solo i simboli ricevono i
            tocchi; il resto passa alla mappa sotto. */}
        <svg width={width} height={mapHeight} className={gl === "ready" ? "map-svg" : "map-svg interactive"} role="img" aria-label={t.map.aria}>
          {debug &&
            fences.map((p) => {
              const place = placeByRef.get(p.ref);
              if (!place) return null;
              return place.geofences
                .filter((g) => g.kind === "arrival")
                .map((g, i) => {
                  const c = screen(g.center);
                  const phase = p.fences[i]?.phase ?? "outside";
                  return <circle key={`${p.ref}-${i}`} cx={c.x} cy={c.y} r={g.radiusM / mpp} className={`map-fence ${phase}`} />;
                });
            })}
          {stops.length > 1 && (
            <polyline points={stops.map((p) => screen(p.location)).map((s) => `${s.x},${s.y}`).join(" ")} className="map-route" />
          )}
          {!venuesLayer && content.anchors.map((a) => {
            const s = screen(a.location);
            return <rect key={a.ref} x={s.x - 6} y={s.y - 6} width={12} height={12} className="map-anchor" />;
          })}
          {!venuesLayer && content.places
            .filter((p) => !stopIndex.has(p.ref) && !props.locked?.has(p.ref))
            .map((p) => {
              const s = screen(p.location);
              const state = [
                unverified(p.coordinateStatus) ? "provisional" : "",
                p.ref === selected ? "selected" : "",
                p.ref === runtime.currentPlaceRef ? "here" : "",
                runtime.wasNarrated(p.ref) ? "heard" : "",
              ].join(" ");
              return (
                <g
                  key={p.ref}
                  className={`map-pin ${state}`}
                  transform={`translate(${s.x},${s.y})${p.ref === selected ? " scale(1.35)" : ""}`}
                  onClick={() => select(p.ref)}
                  role="button"
                  aria-label={p.name}
                >
                  {/* Area di tocco più grande dello spillo: si usa camminando, col pollice. */}
                  <circle cx={0} cy={PIN_HEAD_Y + 2} r={16} className="map-hit" />
                  <path d={PIN_PATH} className="map-pin-body" />
                  <circle cx={0} cy={PIN_HEAD_Y} r={2.6} className="map-pin-dot" />
                </g>
              );
            })}
          {venues.map((v) => {
            const s = screen(v.location);
            const on = v.id === selectedVenue;
            return (
              <g
                key={v.id}
                className={`map-venue cat-${v.category} ${on ? "selected" : ""}`}
                transform={`translate(${s.x},${s.y})${on ? " scale(1.3)" : ""}`}
                onClick={() => selectVenue(v.id)}
                role="button"
                aria-label={v.name}
                aria-pressed={on}
              >
                <circle cx={0} cy={0} r={16} className="map-hit" />
                <rect x={-8} y={-8} width={16} height={16} rx={4} className="map-venue-body" />
                <circle cx={0} cy={0} r={2.6} className="map-venue-dot" />
              </g>
            );
          })}
          {!venuesLayer && stops.map((p, i) => {
            const s = screen(p.location);
            const visited = runtime.visited.includes(p.ref);
            const skipped = runtime.skipped.includes(p.ref);
            const isNext = p.ref === next;
            return (
              <g key={p.ref} className="map-stop-g" onClick={() => select(p.ref)}>
                {isNext && <circle cx={s.x} cy={s.y} r={16} className="map-next-ring" />}
                <circle
                  cx={s.x}
                  cy={s.y}
                  r={10}
                  className={`map-stop ${visited ? (skipped ? "skipped" : "visited") : ""} ${isNext ? "next" : ""} ${unverified(p.coordinateStatus) ? "provisional" : ""} ${p.ref === selected ? "selected" : ""}`}
                />
                <text x={s.x} y={s.y + 4} textAnchor="middle" className="map-stop-n">
                  {visited && !skipped ? "✓" : i + 1}
                </text>
              </g>
            );
          })}
          {labels.map((l) => (
            // Anche il nome si può toccare: è più grande dello spillo e a volte lo copre.
            <text
              key={l.id}
              x={l.x}
              y={l.y}
              textAnchor={l.anchor}
              className={`map-label ${showTiles ? "halo" : ""} ${placeByRef.has(l.id) || venueIds.has(l.id) ? "tappable" : ""}`}
              onClick={venueIds.has(l.id) ? () => selectVenue(l.id) : placeByRef.has(l.id) ? () => select(l.id) : undefined}
            >
              {l.text}
            </text>
          ))}
          {me && fix && (
            <g className={simulated ? "map-me simulated" : "map-me"} aria-label={t.map.you}>
              <circle cx={me.x} cy={me.y} r={Math.max(fix.accuracyM / mpp, 10)} className="map-accuracy" />
              <circle cx={me.x} cy={me.y} r={14} className="map-me-pulse" />
              <circle cx={me.x} cy={me.y} r={9} className="map-me-dot" />
              <text x={me.x} y={me.y + 24} textAnchor="middle" className="map-me-label">
                {t.map.you}
              </text>
            </g>
          )}
        </svg>
        <div className="map-controls" onPointerDown={(e) => e.stopPropagation()}>
          <button className="map-btn" onClick={() => zoomBy(1)} aria-label={t.map.zoomIn}>+</button>
          <button className="map-btn" onClick={() => zoomBy(-1)} aria-label={t.map.zoomOut}>−</button>
          {fix && (
            <button className={`map-btn ${following ? "on" : ""}`} onClick={() => choose("me")} aria-label={t.map.center} aria-pressed={following}>⌖</button>
          )}
          <button
            className="map-btn"
            onClick={() => setFullscreen(!fullscreen)}
            aria-label={fullscreen ? t.map.exitFullscreen : t.map.fullscreen}
            aria-pressed={fullscreen}
          >
            {fullscreen ? "✕" : "⛶"}
          </button>
        </div>
        {fix && !following && (
          <button className="map-recenter" onPointerDown={(e) => e.stopPropagation()} onClick={() => choose("me")}>
            ⌖ {t.map.center}
          </button>
        )}
        <div className="map-scale" aria-hidden="true">
          <span style={{ width: scale.px }} />
          {scale.label}
        </div>
        {showTiles && tilesOk && (
          // Attribuzione richiesta dalla licenza dei dati (ODbL) e del fornitore: solo testo, senza link (decisione del 2026-10-18).
          <span className="map-attrib">{TILES.attribution}</span>
        )}
      </div>
      {sel && !controlled && (
        <p className="map-info">
          <strong>{sel.name}</strong>
          {stopIndex.has(sel.ref) && <> · {t.map.stop(stopIndex.get(sel.ref)! + 1, stops.length)}</>}
          {fix && <> · {Math.round(distanceM(fix.location, sel.location))} m</>}
          <br />
          <span className={sel.coordinateStatus === "field_verified" ? "good small" : "warn small"}>
            {sel.coordinateStatus === "field_verified"
              ? t.map.verified
              : sel.coordinateStatus === "map_verified"
                ? t.map.mapVerified
                : t.map.provisional}
          </span>
        </p>
      )}
      <div className="row wrap map-foot">
        <span className="muted small">{simulated ? t.map.legendSimulated : venuesLayer ? t.map.legendYouVenues : t.map.legendYou}</span>
        {venuesLayer && <span className="muted small"><span className="legend-venue" aria-hidden="true" /> {t.map.legendVenues}</span>}
        {!venuesLayer && preliminary && <span className="muted small">{t.map.legendProvisional}</span>}
        {!venuesLayer && notFieldVerified && <span className="muted small">{t.map.legendMapVerified}</span>}
        {online && basemap && (gl === "unavailable" || (!tilesOk && tileErrors > 0)) && <span className="muted small">{t.map.noBasemap}</span>}
        {online ? (
          <label className="check small">
            <input type="checkbox" checked={basemap} onChange={(e) => setBasemap(e.target.checked)} />
            {t.map.basemap}
          </label>
        ) : (
          <span className="muted small">{t.map.offline}</span>
        )}
      </div>
    </section>
  );
}
