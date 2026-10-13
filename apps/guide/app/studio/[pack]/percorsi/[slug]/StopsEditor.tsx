"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { checkStops, moveStop, type Stop } from "../../../../../lib/studio/shared";
import { saveRouteStops } from "../../../actions";

/** Tappe del percorso: riordino con i pulsanti (anche da tastiera), aggiunta, rimozione, sosta e facoltatività. */
export function StopsEditor(props: { pack: string; slug: string; initial: Stop[]; places: { place: string; name: string }[]; canEdit: boolean }) {
  const [stops, setStops] = useState<Stop[]>(props.initial);
  const [adding, setAdding] = useState("");
  const [message, setMessage] = useState<{ ok?: string; error?: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const changed = JSON.stringify(stops) !== JSON.stringify(props.initial);
  const available = props.places.filter((p) => !stops.some((s) => s.place === p.place));

  const update = (next: Stop[]) => {
    setStops(next);
    setMessage(null);
  };
  const save = () => {
    const problem = checkStops(stops);
    if (problem) return setMessage({ error: problem });
    start(async () => {
      const result = await saveRouteStops(props.pack, props.slug, stops.map(({ place, dwellMin, optional }) => ({ place, dwellMin, optional })));
      setMessage(result.error ? { error: result.error } : { ok: "Tappe salvate." });
      if (!result.error) router.refresh();
    });
  };

  return (
    <section aria-labelledby="stops-title">
      <h2 id="stops-title">Tappe</h2>
      <ol className="st-stops">
        {stops.map((s, i) => (
          <li key={s.place}>
            <span className="st-stop-n">{i + 1}</span>
            <span className="st-stop-name">
              {s.name}
              <span className="st-meta">{s.place}</span>
            </span>
            <label className="st-inline">
              Sosta
              <input
                type="number"
                min={1}
                max={240}
                value={s.dwellMin ?? ""}
                placeholder="—"
                disabled={!props.canEdit}
                onChange={(e) => update(stops.map((x, j) => (j === i ? { ...x, dwellMin: e.target.value === "" ? null : Number(e.target.value) } : x)))}
                aria-label={`Sosta in minuti per ${s.name}`}
              />
              min
            </label>
            <label className="st-inline">
              <input
                type="checkbox"
                checked={s.optional}
                disabled={!props.canEdit}
                onChange={(e) => update(stops.map((x, j) => (j === i ? { ...x, optional: e.target.checked } : x)))}
              />
              facoltativa
            </label>
            {props.canEdit && (
              <span className="st-stop-tools">
                <button type="button" className="st-btn st-quiet" onClick={() => update(moveStop(stops, i, -1))} disabled={i === 0} aria-label={`Sposta su ${s.name}`}>
                  ↑
                </button>
                <button type="button" className="st-btn st-quiet" onClick={() => update(moveStop(stops, i, 1))} disabled={i === stops.length - 1} aria-label={`Sposta giù ${s.name}`}>
                  ↓
                </button>
                <button type="button" className="st-btn st-quiet" onClick={() => update(stops.filter((_, j) => j !== i))} disabled={stops.length === 1} aria-label={`Togli ${s.name}`}>
                  Togli
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {props.canEdit && (
        <>
          <div className="st-row st-add">
            <label>
              Aggiungi una tappa
              <select value={adding} onChange={(e) => setAdding(e.target.value)}>
                <option value="">Scegli un luogo…</option>
                {available.map((p) => (
                  <option key={p.place} value={p.place}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="st-btn"
              disabled={!adding}
              onClick={() => {
                const p = props.places.find((x) => x.place === adding);
                if (p) update([...stops, { place: p.place, name: p.name, dwellMin: null, optional: false }]);
                setAdding("");
              }}
            >
              Aggiungi
            </button>
          </div>
          <div className="st-actions">
            <button type="button" className="st-btn st-primary" onClick={save} disabled={!changed || pending}>
              {pending ? "Salvataggio…" : "Salva le tappe"}
            </button>
            {changed && (
              <button type="button" className="st-btn st-quiet" onClick={() => update(props.initial)} disabled={pending}>
                Annulla le modifiche
              </button>
            )}
          </div>
        </>
      )}
      {message?.error && <p className="st-notice st-error" role="alert">{message.error}</p>}
      {message?.ok && <p className="st-notice st-ok" role="status">{message.ok}</p>}
    </section>
  );
}
