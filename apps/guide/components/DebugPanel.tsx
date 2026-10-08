"use client";

import { useEffect, useState } from "react";
import type { BundleContent } from "@guide/bundle/client";
import type { GuideRuntime } from "../lib/runtime";
import {
  addFieldPoint,
  exportFieldPoints,
  loadFieldPoints,
  removeFieldPoint,
  type FieldPoint,
} from "../lib/field-points";

/**
 * Modalità debug per il test sul campo (strumento di redazione, solo in italiano).
 *
 * Mostra ciò che il motore "vede": posizione e precisione, luoghi più vicini con distanza,
 * stato dei geofence, stato redazionale. Permette di rilevare la posizione reale di un luogo
 * e di esportare i rilievi, che diventano le coordinate verificate del Territory Pack.
 */
const PHASE: Record<string, string> = {
  outside: "fuori",
  entering: "in ingresso…",
  inside: "dentro",
  exiting: "in uscita…",
};
const COORD: Record<string, string> = {
  preliminary: "preliminari",
  field_verified: "rilevate",
  needs_review: "da rivedere",
};

export function DebugPanel(props: { content: BundleContent; runtime: GuideRuntime; gpsError: string | null }) {
  const { content, runtime, gpsError } = props;
  const snap = runtime.debugSnapshot();
  const fix = snap.fix;
  const [points, setPoints] = useState<FieldPoint[]>([]);
  const [target, setTarget] = useState<string>("");
  const [note, setNote] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => setPoints(loadFieldPoints(content.destination)), [content.destination]);
  const nearest = snap.places[0]?.ref ?? "";
  const selected = target || nearest;

  const record = (placeRef: string | null) => {
    if (!fix) return;
    const point: FieldPoint = {
      placeRef,
      location: [round(fix.location[0]), round(fix.location[1])],
      accuracyM: Math.round(fix.accuracyM),
      timestamp: fix.timestamp,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    setPoints(addFieldPoint(content.destination, point));
    setNote("");
  };

  const name = (ref: string | null) => (ref ? (content.places.find((p) => p.ref === ref)?.name ?? ref) : "— nota libera —");
  const age = fix ? Math.round((Date.now() - fix.timestamp) / 1000) : null;

  return (
    <section className="card debug" aria-label="Debug">
      <h2>Debug · test sul campo</h2>
      <dl className="debug-grid">
        <dt>Territorio</dt>
        <dd>
          {content.name} <code>{content.destination}</code>
          <br />
          stadio <b>{content.releaseStage}</b>
          {content.editorialStatus && <> · {content.editorialStatus}</>}
          {content.preview && <> · bundle di anteprima</>}
        </dd>
        <dt>Posizione</dt>
        <dd>
          {fix ? (
            <>
              <code>
                {fix.location[1].toFixed(6)}, {fix.location[0].toFixed(6)}
              </code>
              <br />
              precisione <b className={fix.accuracyM > 35 ? "bad" : fix.accuracyM > 15 ? "warn" : "good"}>±{Math.round(fix.accuracyM)} m</b>
              {fix.speedMs !== undefined && <> · {(fix.speedMs * 3.6).toFixed(1)} km/h</>} · {snap.motion} · {age !== null && age >= 0 ? `${age} s fa` : "simulata"}
            </>
          ) : (
            "nessuna posizione: avvia il GPS o la simulazione"
          )}
          {gpsError && <div className="bad">GPS: {gpsError}</div>}
        </dd>
        <dt>Luogo attivo</dt>
        <dd>
          {snap.currentPlaceRef ? name(snap.currentPlaceRef) : "nessuno"}
          {snap.pendingProposal && <> · proposta in attesa: {name(snap.pendingProposal)}</>}
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
            return (
              <tr key={p.ref} className={p.ref === snap.currentPlaceRef ? "active" : ""} onClick={() => setOpen(open === p.ref ? null : p.ref)}>
                <td>
                  {p.name}
                  {p.narratable === 0 && <span className="muted"> · muto</span>}
                  {open === p.ref && (
                    <div className="debug-notes">
                      {p.storyStatus && <div>racconto: {p.storyStatus}</div>}
                      <div>unità raccontabili: {p.narratable}</div>
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
                      {fence.tooImprecise ? "ignorato (precisione)" : PHASE[fence.phase] ?? fence.phase}
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

      <h3>Rileva la posizione reale</h3>
      <p className="muted small">
        Mettiti nel punto in cui il luogo va riconosciuto (es. davanti all'ingresso), aspetta che la precisione scenda sotto i 10–15 m e
        registra. I rilievi restano su questo telefono finché non li esporti.
      </p>
      <div className="debug-form">
        <select value={selected} onChange={(e) => setTarget(e.target.value)} aria-label="Luogo da rilevare">
          {[...content.places]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((p) => (
              <option key={p.ref} value={p.ref}>
                {p.name}
              </option>
            ))}
        </select>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Nota (facoltativa): riferimento visivo, problemi…" />
        <div className="row wrap">
          <button className="button primary" disabled={!fix} onClick={() => record(selected)}>
            📍 Registra qui: {name(selected)}
          </button>
          <button className="button" disabled={!fix} onClick={() => record(null)}>
            ✎ Solo nota con posizione
          </button>
        </div>
        {fix && fix.accuracyM > 15 && <p className="warn small">Precisione bassa (±{Math.round(fix.accuracyM)} m): meglio aspettare.</p>}
      </div>

      {points.length > 0 && (
        <>
          <h3>Rilievi ({points.length})</h3>
          <ol className="debug-points">
            {points.map((p, i) => (
              <li key={`${p.timestamp}-${i}`}>
                <b>{name(p.placeRef)}</b> · <code>{p.location[1]}, {p.location[0]}</code> · ±{p.accuracyM} m
                {p.note && <div className="muted">{p.note}</div>}
                <button className="link" onClick={() => setPoints(removeFieldPoint(content.destination, i))}>
                  elimina
                </button>
              </li>
            ))}
          </ol>
          <button className="button" onClick={() => exportFieldPoints(content.destination, points)}>
            ⬇ Esporta i rilievi (JSON)
          </button>
        </>
      )}
    </section>
  );
}

const round = (n: number) => Math.round(n * 1e7) / 1e7;
