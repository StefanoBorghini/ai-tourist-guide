"use client";

import type { BundleContent } from "@guide/bundle/client";
import type { GuideRuntime } from "../lib/runtime";

/**
 * Mappa schematica: luoghi, percorso e posizione. È secondaria per scelta
 * (la guida è il prodotto); la mappa vettoriale offline arriverà con i tile del territorio.
 */
export function MiniMap({ content, runtime }: { content: BundleContent; runtime: GuideRuntime }) {
  const points: (readonly [number, number])[] = [...content.places.map((p) => p.location), ...content.anchors.map((a) => a.location)];
  if (runtime.lastFix) points.push(runtime.lastFix.location);
  const lngs = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...lngs), Math.max(...lngs), Math.min(...lats), Math.max(...lats)];
  const pad = 0.12;
  const w = 320;
  const h = 200;
  const sx = (maxX - minX || 1e-6) * (1 + 2 * pad);
  const sy = (maxY - minY || 1e-6) * (1 + 2 * pad);
  const x = (lng: number) => ((lng - minX + (maxX - minX) * pad) / sx) * w;
  const y = (lat: number) => h - ((lat - minY + (maxY - minY) * pad) / sy) * h;
  const route = runtime.plan?.stops
    .map((s) => content.places.find((p) => p.ref === s.placeId))
    .filter((p): p is NonNullable<typeof p> => !!p);

  return (
    <section className="card map" aria-hidden="true">
      <svg viewBox={`0 0 ${w} ${h}`} role="img">
        {route && route.length > 1 && (
          <polyline
            points={route.map((p) => `${x(p.location[0])},${y(p.location[1])}`).join(" ")}
            className="map-route"
          />
        )}
        {content.anchors.map((a) => (
          <g key={a.ref}>
            <rect x={x(a.location[0]) - 5} y={y(a.location[1]) - 5} width={10} height={10} className="map-anchor" />
            <Label x={x(a.location[0])} y={y(a.location[1])} width={w} text={a.name} />
          </g>
        ))}
        {content.places.map((p) => {
          const visited = runtime.visited.includes(p.ref);
          return (
            <g key={p.ref}>
              <circle cx={x(p.location[0])} cy={y(p.location[1])} r={4 + p.importance} className={visited ? "map-place visited" : "map-place"} />
              <Label x={x(p.location[0])} y={y(p.location[1])} width={w} text={p.name} />
            </g>
          );
        })}
        {runtime.lastFix && (
          <circle cx={x(runtime.lastFix.location[0])} cy={y(runtime.lastFix.location[1])} r={6} className="map-me" />
        )}
      </svg>
    </section>
  );
}

/** Etichetta che si sposta a sinistra del punto quando sarebbe tagliata dal bordo destro. */
function Label({ x, y, width, text }: { x: number; y: number; width: number; text: string }) {
  const right = x > width * 0.65;
  return (
    <text x={right ? x - 9 : x + 9} y={y + 4} textAnchor={right ? "end" : "start"} className="map-label">
      {text}
    </text>
  );
}
