"use client";
/**
 * Eventi del giorno nella guida (solo online, mai nel pacchetto offline né nelle risposte dell'AI). Tre pezzi:
 * - useLocalEvents: legge `/api/v1/events` per la destinazione, con una copia in memoria di un minuto;
 * - EventsPanel: viste Oggi / Domani / 7 giorni, filtri, schede degli eventi con fonte e data di verifica;
 * - EventsHomeButton: nella home, un pulsante «Oggi a …» che apre il pannello sopra la foto (la home non scorre).
 * Regole di date, filtri ed etichette in lib/events-view.ts.
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  categoriesIn, countInRange, dayLabel, EVENTS_RANGES, eventDays, eventsUrl, stateFromResponse, timeLabel, verifiedDate,
  type EventCategoryId, type EventsRange, type EventsState, type PublicEvent,
} from "../lib/events-view";
import type { UiText } from "../lib/i18n";
import { Icon } from "./Icon";

const TTL_MS = 60_000;
const memory = new Map<string, { at: number; state: EventsState }>();

/** Eventi della destinazione; `null` come territorio = nessuna destinazione da mostrare. */
export function useLocalEvents(territory: string | null, lang: string | null, online: boolean): [EventsState, () => void] {
  const key = territory ? eventsUrl(territory, lang) : null;
  const [state, setState] = useState<EventsState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key) return;
    if (!online) {
      setState({ kind: "offline" });
      return;
    }
    const kept = memory.get(key);
    if (kept && Date.now() - kept.at < TTL_MS) {
      setState(kept.state);
      return;
    }
    const ctrl = new AbortController();
    setState({ kind: "loading" });
    fetch(key, { signal: ctrl.signal, credentials: "omit" })
      .then(async (r) => stateFromResponse(r.status, await r.json().catch(() => null)))
      .catch((e: Error) => (e.name === "AbortError" ? null : ({ kind: "error" } as EventsState)))
      .then((next) => {
        if (!next) return;
        // Solo gli esiti stabili restano in memoria: un errore si riprova alla prossima apertura.
        if (next.kind === "ok" || next.kind === "unavailable") memory.set(key, { at: Date.now(), state: next });
        setState(next);
      });
    return () => ctrl.abort();
  }, [key, online, attempt]);
  const retry = useCallback(() => {
    if (key) memory.delete(key);
    setAttempt((n) => n + 1);
  }, [key]);
  return [state, retry];
}

function EventCard({ e, day, locale, timezone, t }: { e: PublicEvent; day: string; locale: string; timezone: string; t: UiText }) {
  const w = t.events;
  const off = e.status === "cancelled" || e.status === "postponed";
  const verified = verifiedDate(e.verifiedAt, timezone, locale);
  const links = ([["source", e.links.source], ["info", e.links.info], ["booking", e.links.booking]] as const).filter(([, href]) => href);
  return (
    <li className={`event ${off ? "off" : ""}`}>
      <div className="event-time">
        <Icon name="clock" size={15} /> {timeLabel(e, day, locale, { tbc: w.tbc, allDay: w.allDay, until: w.until })}
      </div>
      <div className="event-main">
        <div className="event-badges">
          {e.status !== "scheduled" && <span className={`badge status-${e.status}`}>{w.status[e.status]}</span>}
          <span className="badge cat">{w.categories[e.category]}</span>
          <span className={`badge price-${e.price.kind}`}>{w.price[e.price.kind]}</span>
        </div>
        <strong className="event-title">{e.title}</strong>
        <span className="event-venue"><Icon name="pin" size={15} /> {e.venue.name}{e.venue.address ? ` · ${e.venue.address}` : ""}</span>
        {e.statusNote && <p className="event-note">{e.statusNote}</p>}
        {e.summary && <p className="event-summary">{e.summary}</p>}
        {(e.description || e.organizer || e.price.note) && (
          <details className="event-more">
            <summary>{w.details}</summary>
            {e.description && <p>{e.description}</p>}
            {e.price.note && <p className="muted small">{e.price.note}</p>}
            {e.organizer && <p className="muted small">{w.organizer}: {e.organizer}</p>}
          </details>
        )}
        {links.length > 0 && (
          <div className="event-links">
            {links.map(([kind, href]) => (
              <a key={kind} href={href!} target="_blank" rel="noopener noreferrer nofollow" className={kind === "booking" ? "button small primary" : "button small quiet"}>
                {w[kind]} <Icon name="forward" size={14} />
              </a>
            ))}
          </div>
        )}
        {verified && <span className="muted small">{w.verified(verified)}</span>}
      </div>
    </li>
  );
}

export function EventsPanel({ state, onRetry, locale, t }: { state: EventsState; onRetry: () => void; locale: string; t: UiText }) {
  const w = t.events;
  const [range, setRange] = useState<EventsRange>("today");
  const [category, setCategory] = useState<EventCategoryId | null>(null);
  const [freeOnly, setFreeOnly] = useState(false);
  if (state.kind === "loading") return <p className="muted small" role="status">{w.loading}</p>;
  if (state.kind === "offline") return <p className="notice"><Icon name="wifiOff" /> {w.offline}</p>;
  if (state.kind === "unavailable") return <p className="muted small">{w.none}</p>;
  if (state.kind === "error") {
    return (
      <div className="notice">
        <Icon name="info" /> <span>{w.error}</span>
        <button className="link" onClick={onRetry}>{w.retry}</button>
      </div>
    );
  }
  const { data } = state;
  const now = Date.now();
  const days = eventDays(data, range, { category, freeOnly }, now);
  const categories = categoriesIn(data);
  const filtered = category !== null || freeOnly;
  return (
    <div className="events">
      <div className="segmented wide" role="group" aria-label={w.title}>
        {EVENTS_RANGES.map((r) => (
          <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>
            {w.ranges[r]} <span className="muted">({countInRange(data, r, now)})</span>
          </button>
        ))}
      </div>
      {(categories.length > 1 || data.events.some((e) => e.price.kind === "free")) && (
        <div className="event-filters" role="group" aria-label={w.title}>
          <button className={`chip small ${category === null && !freeOnly ? "on" : ""}`} onClick={() => { setCategory(null); setFreeOnly(false); }}>{w.all}</button>
          <button className={`chip small ${freeOnly ? "on" : ""}`} aria-pressed={freeOnly} onClick={() => setFreeOnly(!freeOnly)}>{w.freeOnly}</button>
          {categories.length > 1 && categories.map((c) => (
            <button key={c} className={`chip small ${category === c ? "on" : ""}`} aria-pressed={category === c} onClick={() => setCategory(category === c ? null : c)}>
              {w.categories[c]}
            </button>
          ))}
        </div>
      )}
      {days.length === 0 ? (
        <p className="muted small">{filtered ? w.noneFiltered : w.none}</p>
      ) : (
        days.map(({ date, events }) => (
          <section key={date} className="event-day" aria-label={dayLabel(date, data.today, locale, w)}>
            {range === "week" && <h3>{dayLabel(date, data.today, locale, w)}</h3>}
            <ul className="event-list">
              {events.map((e) => <EventCard key={e.id} e={e} day={date} locale={locale} timezone={data.timezone} t={t} />)}
            </ul>
          </section>
        ))
      )}
      <p className="muted small">{w.disclaimer}</p>
    </div>
  );
}

/** Home: pulsante sulla foto solo se ci sono eventi nei prossimi sette giorni; apre il pannello sopra la pagina. */
export function EventsHomeButton({ state, onRetry, name, locale, t }: { state: EventsState; onRetry: () => void; name: string; locale: string; t: UiText }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (state.kind !== "ok") return null;
  const now = Date.now();
  const today = countInRange(state.data, "today", now);
  const week = countInRange(state.data, "week", now);
  if (week === 0) return null;
  const w = t.events;
  return (
    <>
      <button className="button on-photo events-cta" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <Icon name="calendar" size={18} /> {today > 0 ? `${w.todayIn(name)} · ${w.count(today)}` : `${w.title} · ${w.count(week)}`}
      </button>
      {/* Nel body: dentro la home un antenato animato con transform farebbe da contenitore al pannello fisso. */}
      {open && createPortal(
        <div className="events-sheet" role="dialog" aria-modal="true" aria-label={`${w.title} · ${name}`} onClick={(ev) => { if (ev.target === ev.currentTarget) setOpen(false); }}>
          <div className="events-sheet-body">
            <header className="events-sheet-head">
              <h2><Icon name="calendar" /> {w.title} · {name}</h2>
              <button className="round-btn" onClick={() => setOpen(false)} aria-label={w.close} autoFocus><Icon name="close" /></button>
            </header>
            <EventsPanel state={state} onRetry={onRetry} locale={locale} t={t} />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
