"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { BundleContent } from "@guide/bundle/client";
import { distanceM } from "@guide/context-engine";
import type { UiText } from "../lib/i18n";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  fitView,
  metersPerPixel,
  panBy,
  placeLabels,
  scaleBar,
  toScreen,
  visibleTiles,
  type LabelCandidate,
  type LngLat,
  type MapViewState,
} from "../lib/map-view";
import type { GuideRuntime } from "../lib/runtime";

/**
 * Mappa del giro: proiezione Web Mercator, sfondo OpenStreetMap quando c'è rete (senza rete resta
 * la mappa schematica), tappe numerate nell'ordine del piano, posizione con la sua precisione,
 * geofence in modalità debug. Le posizioni provvisorie sono tratteggiate: non vanno prese per buone.
 */
const HEIGHT = 260;
/** Oltre questa distanza dalle tappe la posizione non entra nell'inquadratura del percorso (es. prove da casa). */
const NEAR_ROUTE_M = 2000;
const TILE_URL = (z: number, x: number, y: number) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

type Mode = "route" | "me" | "all";

export function MapView(props: {
  content: BundleContent;
  runtime: GuideRuntime;
  debug: boolean;
  online: boolean;
  simulated: boolean;
  t: UiText;
}) {
  const { content, runtime, debug, online, simulated, t } = props;
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [mode, setMode] = useState<Mode>("route");
  const [manual, setManual] = useState<MapViewState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [basemap, setBasemap] = useState(true);
  const [failedTiles, setFailedTiles] = useState<Set<string>>(new Set());
  const [loadedTiles, setLoadedTiles] = useState(0);
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.round(entry!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fix = runtime.lastFix;
  const placeByRef = useMemo(() => new Map(content.places.map((p) => [p.ref, p])), [content]);
  const stops = (runtime.plan?.stops ?? []).map((s) => placeByRef.get(s.placeId)).filter((p): p is NonNullable<typeof p> => !!p);
  const stopIndex = new Map(stops.map((p, i) => [p.ref, i]));
  const next = runtime.nextStop;

  // Inquadratura automatica, finché l'utente non sposta o ingrandisce la mappa.
  const auto = (): MapViewState => {
    if (mode === "me" && fix) return { center: fix.location, zoom: 18 };
    if (mode === "all") return fitView([...content.places.map((p) => p.location), ...content.anchors.map((a) => a.location)], width, HEIGHT);
    const pts: LngLat[] = stops.length > 0 ? stops.map((p) => p.location) : content.places.map((p) => p.location);
    if (fix && pts.some((p) => distanceM(p, fix.location) < NEAR_ROUTE_M)) pts.push(fix.location);
    return fitView(pts, width, HEIGHT);
  };
  const view = manual ?? auto();
  const screen = toScreen(view, width, HEIGHT);
  const mpp = metersPerPixel(view.center[1], view.zoom);
  const showTiles = online && basemap;
  const tiles = showTiles ? visibleTiles(view, width, HEIGHT) : [];
  const scale = scaleBar(view.center[1], view.zoom);
  const fences = runtime.debugSnapshot().places;
  const preliminary = content.places.some((p) => p.coordinateStatus !== "field_verified");

  const labelCandidates: LabelCandidate[] = [
    ...content.places.map((p) => {
      const s = screen(p.location);
      const i = stopIndex.get(p.ref);
      const priority = p.ref === next ? 100 : p.ref === runtime.currentPlaceRef ? 95 : i !== undefined ? 80 - i : p.importance * 5;
      return { id: p.ref, x: s.x, y: s.y, text: p.name, priority, offset: i !== undefined ? 11 : 6 };
    }),
    ...content.anchors.map((a) => ({ id: a.ref, ...screen(a.location), text: a.name, priority: 40, offset: 7 })),
  ];
  const labels = placeLabels(labelCandidates, width, HEIGHT);

  const zoomBy = (d: number) => setManual({ ...view, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom + d)) });
  const choose = (m: Mode) => {
    setMode(m);
    setManual(null);
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: 0 };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.moved += Math.abs(dx) + Math.abs(dy);
    d.x = e.clientX;
    d.y = e.clientY;
    if (d.moved > 4) {
      // La cattura parte solo quando è davvero un trascinamento: un tocco deve arrivare al simbolo.
      const el = e.currentTarget as HTMLElement;
      if (!el.hasPointerCapture(e.pointerId)) el.setPointerCapture(e.pointerId);
      setManual(panBy(view, dx, dy));
    }
  };
  const onPointerUp = () => {
    setTimeout(() => (drag.current = null), 0);
  };
  const select = (ref: string) => {
    if (drag.current && drag.current.moved > 4) return;
    setSelected(selected === ref ? null : ref);
  };

  const sel = selected ? placeByRef.get(selected) : undefined;
  const me = fix ? screen(fix.location) : null;

  return (
    <section className="card mapview">
      <div className="row wrap map-modes">
        {(["route", "me", "all"] as const).map((m) => (
          <button key={m} className={`chip small ${mode === m && !manual ? "on" : ""}`} onClick={() => choose(m)} disabled={m === "me" && !fix}>
            {t.map[m]}
          </button>
        ))}
      </div>
      <div
        ref={boxRef}
        className="map-box"
        style={{ height: HEIGHT }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {tiles.map((tile) =>
          failedTiles.has(tile.key) ? null : (
            // eslint-disable-next-line @next/next/no-img-element -- tile cartografici esterni, non ottimizzabili da Next
            <img
              key={tile.key}
              src={TILE_URL(tile.z, tile.x, tile.y)}
              alt=""
              className="map-tile"
              style={{ left: tile.left, top: tile.top }}
              draggable={false}
              onLoad={() => setLoadedTiles((n) => n + 1)}
              onError={() => setFailedTiles((s) => new Set(s).add(tile.key))}
            />
          ),
        )}
        <svg width={width} height={HEIGHT} className="map-svg" role="img" aria-label={t.map.aria}>
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
          {content.anchors.map((a) => {
            const s = screen(a.location);
            return <rect key={a.ref} x={s.x - 6} y={s.y - 6} width={12} height={12} className="map-anchor" />;
          })}
          {content.places
            .filter((p) => !stopIndex.has(p.ref))
            .map((p) => {
              const s = screen(p.location);
              return (
                <circle
                  key={p.ref}
                  cx={s.x}
                  cy={s.y}
                  r={5}
                  className={`map-poi ${p.coordinateStatus !== "field_verified" ? "provisional" : ""} ${p.ref === selected ? "selected" : ""}`}
                  onClick={() => select(p.ref)}
                />
              );
            })}
          {stops.map((p, i) => {
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
                  className={`map-stop ${visited ? (skipped ? "skipped" : "visited") : ""} ${isNext ? "next" : ""} ${p.coordinateStatus !== "field_verified" ? "provisional" : ""} ${p.ref === selected ? "selected" : ""}`}
                />
                <text x={s.x} y={s.y + 4} textAnchor="middle" className="map-stop-n">
                  {visited && !skipped ? "✓" : i + 1}
                </text>
              </g>
            );
          })}
          {labels.map((l) => (
            <text key={l.id} x={l.x} y={l.y} textAnchor={l.anchor} className={`map-label ${showTiles ? "halo" : ""}`}>
              {l.text}
            </text>
          ))}
          {me && fix && (
            <g className={simulated ? "map-me simulated" : "map-me"}>
              <circle cx={me.x} cy={me.y} r={Math.max(fix.accuracyM / mpp, 8)} className="map-accuracy" />
              <circle cx={me.x} cy={me.y} r={7} className="map-me-dot" />
            </g>
          )}
        </svg>
        <div className="map-controls" onPointerDown={(e) => e.stopPropagation()}>
          <button className="map-btn" onClick={() => zoomBy(1)} aria-label={t.map.zoomIn}>+</button>
          <button className="map-btn" onClick={() => zoomBy(-1)} aria-label={t.map.zoomOut}>−</button>
          {fix && (
            <button className="map-btn" onClick={() => choose("me")} aria-label={t.map.center}>⌖</button>
          )}
        </div>
        <div className="map-scale" aria-hidden="true">
          <span style={{ width: scale.px }} />
          {scale.label}
        </div>
        {showTiles && loadedTiles > 0 && (
          <a className="map-attrib" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            © OpenStreetMap
          </a>
        )}
      </div>
      {sel && (
        <p className="map-info">
          <strong>{sel.name}</strong>
          {stopIndex.has(sel.ref) && <> · {t.map.stop(stopIndex.get(sel.ref)! + 1, stops.length)}</>}
          {fix && <> · {Math.round(distanceM(fix.location, sel.location))} m</>}
          <br />
          <span className={sel.coordinateStatus === "field_verified" ? "good small" : "warn small"}>
            {sel.coordinateStatus === "field_verified" ? t.map.verified : t.map.provisional}
          </span>
        </p>
      )}
      <div className="row wrap map-foot">
        {preliminary && <span className="muted small">{t.map.legendProvisional}</span>}
        {showTiles && loadedTiles === 0 && failedTiles.size > 0 && <span className="muted small">{t.map.noBasemap}</span>}
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
