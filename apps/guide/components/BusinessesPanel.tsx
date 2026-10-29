"use client";
/**
 * Directory gratuita delle attività locali nella guida (bar, ristoranti, negozi, dove dormire, servizi). Solo online,
 * mai nel pacchetto offline né nelle risposte dell'AI; nessun account né acquisto. Due pezzi:
 * - useLocalBusinesses: legge `/api/v1/businesses` per la destinazione, con una copia in memoria di cinque minuti;
 * - BusinessesPanel: filtri per categoria e schede (foto con i crediti, orari solo se verificati di recente, chiamata,
 *   sito, «Mostra sulla mappa» nella mappa della guida: nessun collegamento a mappe esterne).
 * «Ascolta»: GAIA legge con la sua voce la descrizione scritta e verificata dalla redazione, parola per parola. Nessuna
 * AI: niente testo generato e niente domande sulle attività.
 * Ordine neutrale: alfabetico, o per distanza se si conosce la posizione. Regole in lib/businesses-view.ts.
 */
import { useCallback, useEffect, useState } from "react";
import {
  businessCategoriesIn, businessesStateFromResponse, businessesUrl, businessVerifiedDate, distanceLabel, hoursFresh,
  listBusinesses, telHref, type BusinessCategoryId, type BusinessesState, type ListedBusiness,
} from "../lib/businesses-view";
import type { UiText } from "../lib/i18n";
import type { LngLat } from "../lib/map-view";
import { Icon } from "./Icon";

const TTL_MS = 5 * 60_000;
const memory = new Map<string, { at: number; state: BusinessesState }>();

/** Attività della destinazione; `null` come territorio = nessuna destinazione da mostrare. */
export function useLocalBusinesses(territory: string | null, lang: string | null, online: boolean): [BusinessesState, () => void] {
  const key = territory ? businessesUrl(territory, lang) : null;
  const [state, setState] = useState<BusinessesState>({ kind: "loading" });
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
    fetch(key, { signal: ctrl.signal, credentials: "same-origin" })
      .then(async (r) => businessesStateFromResponse(r.status, await r.json().catch(() => null)))
      .catch((e: Error) => (e.name === "AbortError" ? null : ({ kind: "error" } as BusinessesState)))
      .then((next) => {
        if (!next) return;
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

/** Foto dell'attività, come la galleria dei luoghi: scorrimento orizzontale, credito su ciascuna. */
function BusinessGallery({ photos, t }: { photos: ListedBusiness["business"]["photos"]; t: UiText }) {
  if (photos.length === 0) return null;
  return (
    <div className="business-media">
      <div className="gallery">
        {photos.map((f) => (
          <figure key={f.url}>
            {/* eslint-disable-next-line @next/next/no-img-element -- foto dal bucket pubblico, già ridotte nello Studio */}
            <img src={f.url} alt={f.alt} loading="lazy" decoding="async" />
            {f.credit && (
              <figcaption>
                {f.originalUrl ? <a href={f.originalUrl} target="_blank" rel="noopener noreferrer nofollow">{`${t.photo}: ${f.credit}`}</a> : `${t.photo}: ${f.credit}`}
              </figcaption>
            )}
          </figure>
        ))}
      </div>
      {photos.length > 1 && <span className="gallery-count">{t.photos(photos.length)}</span>}
    </div>
  );
}

export function BusinessCard({ row, locale, t, onClose, onShowOnMap, onListen, listening }: {
  row: ListedBusiness;
  locale: string;
  t: UiText;
  onClose?: () => void;
  /** Centra la mappa della guida sull'attività (solo se ha le coordinate). */
  onShowOnMap?: (row: ListedBusiness) => void;
  /** Lettura ad alta voce della descrizione (solo se c'è una descrizione e la voce del dispositivo). */
  onListen?: (row: ListedBusiness) => void;
  /** La voce sta leggendo questa attività: il pulsante diventa «Ferma». */
  listening?: boolean;
}) {
  const w = t.businesses;
  const b = row.business;
  const now = Date.now();
  const fresh = hoursFresh(b.verifiedAt, now);
  const verified = businessVerifiedDate(b.verifiedAt, locale);
  return (
    <li className={`event business${b.photos.length > 0 ? " with-photo" : ""}`}>
      <BusinessGallery photos={b.photos} t={t} />
      <div className="event-main">
        {onClose && (
          <button className="round-btn venue-close" onClick={onClose} aria-label={w.closeDetail}><Icon name="close" size={18} /></button>
        )}
        <div className="event-badges">
          <span className="badge cat">{b.subcategory ?? w.categories[b.category]}</span>
          {row.distanceM !== null && <span className="badge">{w.away(distanceLabel(row.distanceM, locale))}</span>}
        </div>
        <strong className="event-title">{b.name}</strong>
        {b.address && <span className="event-venue"><Icon name="pin" size={15} /> {b.address}</span>}
        {b.hours && fresh && <span className="event-venue"><Icon name="clock" size={15} /> {b.hours}</span>}
        {b.hours && !fresh && <span className="muted small"><Icon name="clock" size={15} /> {w.hoursStale}</span>}
        {b.description && <p className="event-summary">{b.description}</p>}
        <div className="event-links">
          {b.description && onListen && (
            <button className="button small" onClick={() => onListen(row)} aria-pressed={listening === true}>
              <Icon name={listening ? "pause" : "volume"} size={14} /> {listening ? w.stopListening : w.listen}
            </button>
          )}
          {b.phone && (
            <a href={telHref(b.phone)} className="button small quiet"><Icon name="phone" size={14} /> {w.call}</a>
          )}
          {b.location && onShowOnMap && (
            <button className="button small quiet" onClick={() => onShowOnMap(row)}><Icon name="pin" size={14} /> {w.showOnMap}</button>
          )}
          {b.website && (
            <a href={b.website} target="_blank" rel="noopener noreferrer nofollow" className="button small quiet"><Icon name="globe" size={14} /> {w.website}</a>
          )}
          {b.email && (
            <a href={`mailto:${b.email}`} className="button small quiet"><Icon name="mail" size={14} /> {w.email}</a>
          )}
        </div>
        {verified && <span className="muted small">{w.verified(verified)}</span>}
      </div>
    </li>
  );
}

/** Filtri per categoria della modalità «Locali e attività» (controllati dal genitore: valgono per mappa ed elenco). */
export function VenueFilters({ categories, category, onChange, t }: {
  categories: readonly BusinessCategoryId[];
  category: BusinessCategoryId | null;
  onChange: (c: BusinessCategoryId | null) => void;
  t: UiText;
}) {
  const w = t.businesses;
  if (categories.length < 2) return null;
  return (
    <div className="event-filters venue-filters" role="group" aria-label={w.title}>
      <button className={`chip small ${category === null ? "on" : ""}`} aria-pressed={category === null} onClick={() => onChange(null)}>{w.all}</button>
      {categories.map((c) => (
        <button key={c} className={`chip small ${category === c ? "on" : ""}`} aria-pressed={category === c} onClick={() => onChange(category === c ? null : c)}>
          {w.categories[c]}
        </button>
      ))}
    </div>
  );
}

/** Elenco compatto e selezionabile (una riga per attività, come l'elenco dei luoghi). */
export function VenueList({ rows, selected, onSelect, locale, t }: {
  rows: readonly ListedBusiness[];
  selected: string | null;
  onSelect: (id: string) => void;
  locale: string;
  t: UiText;
}) {
  const w = t.businesses;
  return (
    <ul className="places venues">
      {rows.map(({ business: b, distanceM: d }) => (
        <li key={b.id}>
          <button className={`place-row venue-row ${b.id === selected ? "on" : ""}`} onClick={() => onSelect(b.id)} aria-pressed={b.id === selected}>
            <span className={`venue-badge cat-${b.category}`} aria-hidden="true"><Icon name="shop" size={18} /></span>
            <span>
              <span className="name">{b.name}</span>
              <span className="short">{b.subcategory ?? w.categories[b.category]}{b.address ? ` · ${b.address}` : ""}</span>
            </span>
            <span className="dist">{d !== null ? distanceLabel(d, locale) : null}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Stato vuoto curato: nessuna attività pubblicata per la destinazione (o nessuna nella categoria scelta). */
export function VenuesEmpty({ name, filtered, t }: { name: string; filtered: boolean; t: UiText }) {
  const w = t.businesses;
  return (
    <section className="card venues-empty" role="status">
      <span className="venue-badge big" aria-hidden="true"><Icon name="shop" size={26} /></span>
      {filtered ? <p>{w.emptyFiltered}</p> : (
        <>
          <h3>{w.emptyTitle(name)}</h3>
          <p className="muted">{w.emptyText}</p>
        </>
      )}
    </section>
  );
}

export function BusinessesPanel({ state, onRetry, here, locale, t, onShowOnMap, onListen, listeningId }: {
  state: BusinessesState;
  onRetry: () => void;
  /** Posizione del visitatore, per ordinare dalla più vicina; null = ordine alfabetico. */
  here: LngLat | null;
  locale: string;
  t: UiText;
  onShowOnMap?: (row: ListedBusiness) => void;
  onListen?: (row: ListedBusiness) => void;
  listeningId?: string | null;
}) {
  const w = t.businesses;
  const [category, setCategory] = useState<BusinessCategoryId | null>(null);
  if (state.kind === "loading") return <p className="muted small" role="status">{w.loading}</p>;
  if (state.kind === "offline") return <p className="notice"><Icon name="wifiOff" /> {w.offline}</p>;
  if (state.kind === "unavailable") return null;
  if (state.kind === "error") {
    return (
      <div className="notice">
        <Icon name="info" /> <span>{w.error}</span>
        <button className="link" onClick={onRetry}>{w.retry}</button>
      </div>
    );
  }
  const categories = businessCategoriesIn(state.data.businesses);
  const rows = listBusinesses(state.data, category, here);
  return (
    <div className="events businesses">
      {categories.length > 1 && (
        <div className="event-filters" role="group" aria-label={w.title}>
          <button className={`chip small ${category === null ? "on" : ""}`} aria-pressed={category === null} onClick={() => setCategory(null)}>{w.all}</button>
          {categories.map((c) => (
            <button key={c} className={`chip small ${category === c ? "on" : ""}`} aria-pressed={category === c} onClick={() => setCategory(category === c ? null : c)}>
              {w.categories[c]}
            </button>
          ))}
        </div>
      )}
      {here && rows.some((r) => r.distanceM !== null) && <p className="muted small">{w.nearest}</p>}
      <ul className="event-list">
        {rows.map((row) => <BusinessCard key={row.business.id} row={row} locale={locale} t={t} onShowOnMap={onShowOnMap} onListen={onListen} listening={listeningId === row.business.id} />)}
      </ul>
      <p className="muted small">{w.disclaimer}</p>
    </div>
  );
}
