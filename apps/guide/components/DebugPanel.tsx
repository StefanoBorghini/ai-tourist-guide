"use client";

import { useEffect, useMemo, useState } from "react";
import type { BundleContent } from "@guide/bundle/client";
import type { FieldPointKind, FieldPointRecord } from "@guide/domain";
import { fenceOverlaps, placeKnowledge } from "../lib/diagnostics";
import {
  addFieldPoint,
  buildFieldPoint,
  downloadFieldPoints,
  fieldPointsExport,
  loadFieldPoints,
  removeFieldPoint,
  shareFieldPoints,
  type PositionSource,
} from "../lib/field-points";
import type { GuideRuntime } from "../lib/runtime";

/**
 * Modalità debug per il test sul campo (strumento di redazione, solo in italiano).
 *
 * Mostra ciò che il motore "vede": posizione e precisione (reale o simulata), luoghi più vicini,
 * stato dei geofence e loro sovrapposizioni, stato redazionale, rete e cache offline.
 * Permette di registrare rilievi associati a un luogo e di esportarli per la revisione.
 */
const PHASE: Record<string, string> = {
  outside: "fuori",
  entering: "in ingresso…",
  inside: "dentro",
  exiting: "in uscita…",
};
const COORD: Record<string, string> = {
  preliminary: "preliminari",
  field_verified: "verificate sul campo",
  needs_review: "da rivedere",
};
const KIND: Record<FieldPointKind, string> = {
  poi_position: "Posizione del luogo",
  geofence_edge: "Bordo del geofence (qui deve iniziare il racconto)",
  note: "Nota con posizione",
};

export interface DebugPanelProps {
  content: BundleContent;
  runtime: GuideRuntime;
  gpsError: string | null;
  /** Provenienza dell'ultima posizione: GPS reale o camminata simulata. */
  fixSource: PositionSource | null;
  online: boolean;
  /** true / false se noto, null se non verificabile (cache non disponibile). */
  offlineReady: boolean | null;
  bundleHash: string | null;
}

export function DebugPanel(props: DebugPanelProps) {
  const { content, runtime, gpsError, fixSource, online, offlineReady, bundleHash } = props;
  const snap = runtime.debugSnapshot();
  const fix = snap.fix;
  const overlaps = useMemo(() => fenceOverlaps(content), [content]);
  const [points, setPoints] = useState<FieldPointRecord[]>([]);
  const [target, setTarget] = useState<string>("");
  const [kind, setKind] = useState<FieldPointKind>("poi_position");
  const [note, setNote] = useState("");
  const [radius, setRadius] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => setPoints(loadFieldPoints(content.destination)), [content.destination]);
  const nearest = snap.places[0]?.ref ?? "";
  const selected = kind === "note" && target === "" ? "" : target || nearest;
  const device = typeof navigator !== "undefined" ? navigator.userAgent : null;
  const name = (ref: string | null) => (ref ? (content.places.find((p) => p.ref === ref)?.name ?? ref) : "— nessun luogo —");
  const age = fix ? Math.round((Date.now() - fix.timestamp) / 1000) : null;
  const overlapsOf = (ref: string) => overlaps.filter((o) => o.a === ref || o.b === ref);

  const record = () => {
    if (!fix || !fixSource) return;
    const placeRef = selected || null;
    const point = buildFieldPoint({
      content,
      placeRef,
      kind,
      fix,
      source: fixSource,
      note,
      suggestedRadiusM: radius ? Number(radius) : null,
      device,
    });
    setPoints(addFieldPoint(content.destination, point));
    setNote("");
    setRadius("");
    setMessage(`Registrato: ${KIND[kind]} · ${name(placeRef)}${fixSource === "simulated" ? " (posizione SIMULATA)" : ""}`);
  };

  const exportData = () => fieldPointsExport(content.destination, bundleHash, points, device);

  return (
    <section className="card debug" aria-label="Debug">
      <h2>Debug · test sul campo</h2>
      <dl className="debug-grid">
        <dt>Territorio</dt>
        <dd>
          {content.name} <code>{content.destination}</code>
          <br />
          stadio <b>{content.releaseStage}</b>
          {content.preview && <> · anteprima (contenuti in revisione)</>}
        </dd>
        <dt>Posizione</dt>
        <dd>
          {fix ? (
            <>
              <span className={`source ${fixSource === "gps" ? "good" : "warn"}`}>{fixSource === "gps" ? "GPS REALE" : "SIMULATA"}</span>
              <br />
              <code>
                {fix.location[1].toFixed(6)}, {fix.location[0].toFixed(6)}
              </code>
              <br />
              precisione <b className={fix.accuracyM > 35 ? "bad" : fix.accuracyM > 15 ? "warn" : "good"}>±{Math.round(fix.accuracyM)} m</b>
              {fix.speedMs !== undefined && <> · {(fix.speedMs * 3.6).toFixed(1)} km/h</>} · {snap.motion}
              {fixSource === "gps" && age !== null && age >= 0 && <> · {age} s fa</>}
              {fix.accuracyM > 35 && <div className="bad">Precisione insufficiente: i geofence la ignorano. Usa «Sono qui».</div>}
            </>
          ) : (
            "nessuna posizione: avvia il GPS o la simulazione"
          )}
          {gpsError && <div className="bad">GPS: {gpsError}</div>}
        </dd>
        <dt>Luogo attivo</dt>
        <dd>
          {snap.currentPlaceRef ? name(snap.currentPlaceRef) : "nessuno"}
          {snap.currentPlaceRef && runtime.manualArrivals.includes(snap.currentPlaceRef) && <span className="warn"> (confermato a mano)</span>}
          {snap.pendingProposal && <> · proposta in attesa: {name(snap.pendingProposal)}</>}
          {runtime.routeStops && (
            <>
              <br />
              percorso: prossima tappa <b>{runtime.nextStop ? name(runtime.nextStop) : "—"}</b>
              {runtime.manualArrivals.length > 0 && <> · arrivi a mano: {runtime.manualArrivals.length}</>}
              {runtime.skipped.length > 0 && <> · saltate: {runtime.skipped.map(name).join(", ")}</>}
            </>
          )}
        </dd>
        <dt>Rete</dt>
        <dd>
          <span className={online ? "good" : "bad"}>{online ? "online" : "offline"}</span> · cache offline{" "}
          {offlineReady === null ? "non verificabile" : offlineReady ? <span className="good">completa</span> : <span className="warn">non scaricata</span>}
        </dd>
      </dl>

      <h3>Luoghi più vicini</h3>
      <table className="debug-table">
        <thead>
          <tr>
            <th>Luogo</th>
            <th>Dist.</th>
            <th>Geofence</th>
            <th>Coord.</th>
          </tr>
        </thead>
        <tbody>
          {snap.places.slice(0, 8).map((p) => {
            const fence = p.fences[0];
            const k = placeKnowledge(content, p.ref);
            const ov = overlapsOf(p.ref);
            return (
              <tr key={p.ref} className={p.ref === snap.currentPlaceRef ? "active" : ""} onClick={() => setOpen(open === p.ref ? null : p.ref)}>
                <td>
                  {p.name}
                  {p.narratable === 0 && <span className="muted"> · muto</span>}
                  {ov.length > 0 && <span className="warn"> · ⚠ sovrapposto</span>}
                  {open === p.ref && (
                    <div className="debug-notes">
                      <div>racconto: {p.storyStatus ?? "—"}</div>
                      <div>
                        informazioni: {k.verified} verificate, {k.inReview} in revisione, {k.sourceUnconfirmed} con fonte da confermare (
                        {k.types.join(", ") || "nessuna"}) · {k.units} unità
                      </div>
                      {ov.map((o) => (
                        <div key={`${o.a}-${o.b}`}>
                          ⚠ si sovrappone con {name(o.a === p.ref ? o.b : o.a)}: centri a {o.distanceM} m, raggi {o.radiusA}+{o.radiusB} m
                        </div>
                      ))}
                      {p.notes.map((n) => (
                        <div key={n}>· {n}</div>
                      ))}
                    </div>
                  )}
                </td>
                <td>{p.distanceM === null ? "–" : `${p.distanceM} m`}</td>
                <td>
                  {fence ? (
                    <>
                      {fence.tooImprecise ? "ignorato (precisione)" : (PHASE[fence.phase] ?? fence.phase)}
                      <br />
                      <span className="muted">r {fence.radiusM} m</span>
                    </>
                  ) : (
                    "predefinito"
                  )}
                </td>
                <td className={p.coordinateStatus === "field_verified" ? "good" : "warn"}>{COORD[p.coordinateStatus] ?? p.coordinateStatus}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">Tocca un luogo per stato delle informazioni, sovrapposizioni e note. Geofence sovrapposti nel territorio: {overlaps.length}.</p>

      <h3>Registra un rilievo</h3>
      <p className="muted small">
        Mettiti nel punto giusto, aspetta una precisione sotto i 10–15 m e registra. I rilievi restano su questo telefono finché non li esporti;
        non modificano il territorio finché non vengono rivisti.
      </p>
      <div className="debug-form">
        <select value={kind} onChange={(e) => setKind(e.target.value as FieldPointKind)} aria-label="Tipo di rilievo">
          {(Object.keys(KIND) as FieldPointKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND[k]}
            </option>
          ))}
        </select>
        <select value={selected} onChange={(e) => setTarget(e.target.value)} aria-label="Luogo">
          {kind === "note" && <option value="">— nessun luogo —</option>}
          {[...content.places]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((p) => (
              <option key={p.ref} value={p.ref}>
                {p.name}
              </option>
            ))}
        </select>
        {kind !== "note" && (
          <input
            type="number"
            inputMode="numeric"
            min={5}
            max={500}
            value={radius}
            onChange={(e) => setRadius(e.target.value)}
            placeholder="Raggio suggerito in metri (facoltativo)"
            aria-label="Raggio suggerito"
          />
        )}
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Nota: riferimento visivo, problemi…" aria-label="Nota" />
        <button className="button primary" disabled={!fix || !fixSource} onClick={record}>
          📍 Registra qui
        </button>
        {fix && fix.accuracyM > 15 && <p className="warn small">Precisione bassa (±{Math.round(fix.accuracyM)} m): meglio aspettare.</p>}
        {fixSource === "simulated" && <p className="warn small">Posizione simulata: il rilievo sarà marcato come simulato e non vale per le coordinate.</p>}
        {message && <p className="good small">{message}</p>}
      </div>

      {points.length > 0 && (
        <>
          <h3>Rilievi ({points.length})</h3>
          <ol className="debug-points">
            {points.map((p, i) => (
              <li key={`${p.recorded_at}-${i}`}>
                <b>{name(p.poi_ref)}</b> · {KIND[p.kind]}
                {p.position_source === "simulated" && <span className="warn"> · SIMULATO</span>}
                <br />
                <code>
                  {p.lat}, {p.lon}
                </code>{" "}
                · ±{p.accuracy_m} m · {p.recorded_at.slice(11, 16)}{p.distance_from_pack_m !== null && <> · {p.distance_from_pack_m} m dal punto del pack</>}
                {p.geofence_radius_suggested_m && <> · raggio suggerito {p.geofence_radius_suggested_m} m</>}
                {p.note && <div className="muted">{p.note}</div>}
                <button className="link" onClick={() => setPoints(removeFieldPoint(content.destination, i))}>
                  elimina
                </button>
              </li>
            ))}
          </ol>
          <div className="row wrap">
            <button
              className="button primary"
              onClick={async () => {
                if (!(await shareFieldPoints(exportData()))) downloadFieldPoints(exportData());
              }}
            >
              ⤴ Condividi i rilievi
            </button>
            <button className="button" onClick={() => downloadFieldPoints(exportData())}>
              ⬇ Scarica JSON
            </button>
          </div>
        </>
      )}
    </section>
  );
}
