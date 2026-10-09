"use client";

import type { BundleContent } from "@guide/bundle/client";
import { bearingDeg, distanceM, type Fix } from "@guide/context-engine";
import { compass, formatDistance } from "../lib/format";
import type { UiText } from "../lib/i18n";

/**
 * Scheda di un luogo (scelto sulla mappa o nell'elenco, oppure quello in cui ci si trova):
 * descrizione breve dal bundle, distanza in linea d'aria, stato della posizione e azioni.
 * Nessun contenuto territoriale scritto qui: tutto arriva dal bundle.
 */
export function PlaceCard(props: {
  content: BundleContent;
  placeRef: string;
  base: string;
  fix: Fix | null;
  isHere: boolean;
  heard: boolean;
  canAsk: boolean;
  t: UiText;
  onListen: () => void;
  onAsk: () => void;
  onHere: () => void;
  onClose?: () => void;
}) {
  const { content, placeRef, base, fix, isHere, heard, canAsk, t } = props;
  const place = content.places.find((p) => p.ref === placeRef);
  if (!place) return null;
  const d = fix ? distanceM(fix.location, place.location) : null;
  return (
    <section className="card place-card" aria-label={place.name}>
      <div className="place-head">
        <div>
          <p className="eyebrow">{isHere ? t.here : d !== null ? `${formatDistance(d, content.locale)} · ${compass(bearingDeg(fix!.location, place.location), t.dirs)}` : " "}</p>
          <h2>{place.name}</h2>
        </div>
        {props.onClose && (
          <button className="link" onClick={props.onClose} aria-label={t.close}>
            ✕
          </button>
        )}
      </div>
      <PlacePhoto content={content} placeRef={place.ref} base={base} label={t.photo} />
      {place.short && <p className="place-short">{place.short}</p>}
      <p className={`small ${place.coordinateStatus === "field_verified" ? "good" : "warn"}`}>
        {place.coordinateStatus === "field_verified" ? t.map.verified : place.coordinateStatus === "map_verified" ? t.map.mapVerified : t.map.provisional}
      </p>
      <div className="place-actions">
        <button className="button primary big" onClick={props.onListen}>
          ▶ {heard ? t.listenAgain : t.listen}
        </button>
        {canAsk && (
          <button className="button big" onClick={props.onAsk}>
            💬 {t.askAbout}
          </button>
        )}
        {!isHere && (
          <button className="button" onClick={props.onHere}>
            📍 {t.imHere}
          </button>
        )}
      </div>
      {heard && <p className="muted small">✓ {t.heard}</p>}
    </section>
  );
}

/** Prima immagine del luogo, con il credito richiesto dalla licenza. */
export function PlacePhoto({ content, placeRef, base, label }: { content: BundleContent; placeRef: string; base: string; label: string }) {
  const media = content.media.find((m) => m.subjects.includes(placeRef));
  if (!media) return null;
  const credit = media.attribution ?? (media.author ? `${label}: ${media.author}` : null);
  return (
    <figure className="place-photo">
      {/* eslint-disable-next-line @next/next/no-img-element -- file statico del bundle, già ottimizzato */}
      <img src={base + media.path} alt={media.alt} loading="lazy" />
      {(media.caption || credit) && (
        <figcaption>
          {media.caption && <span>{media.caption}</span>}
          {credit && (
            <span className="credit">
              {media.originalUrl ? (
                <a href={media.originalUrl} target="_blank" rel="noreferrer">
                  {credit}
                </a>
              ) : (
                credit
              )}
            </span>
          )}
        </figcaption>
      )}
    </figure>
  );
}
