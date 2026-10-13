"use client";

import type { BundleContent, BundleMedia } from "@guide/bundle/client";
import { bearingDeg, distanceM, type Fix } from "@guide/context-engine";
import { compass, formatDistance } from "../lib/format";
import type { UiText } from "../lib/i18n";
import { Icon } from "./Icon";

/** Immagini e video di un luogo, nell'ordine del bundle. */
export function placeMedia(content: BundleContent, placeRef: string): BundleMedia[] {
  // Prima le foto, poi i video (che si avviano solo su richiesta).
  return content.media.filter((m) => m.subjects.includes(placeRef)).sort((a, b) => Number(a.kind === "video") - Number(b.kind === "video"));
}

/** Immagine da usare come miniatura (per i video, il poster). */
export function thumbSrc(media: BundleMedia | undefined, base: string): string | null {
  if (!media) return null;
  return base + (media.kind === "video" ? (media.poster ?? "") : media.path);
}

const credit = (m: BundleMedia, label: string) => m.attribution ?? (m.author ? `${label}: ${m.author}` : null);

/**
 * Miniatura di un luogo: la sua prima immagine, oppure l'iniziale su un fondo di mare
 * (mai una foto di un altro luogo al suo posto).
 */
export function PlaceThumb({ content, placeRef, base, name, className }: { content: BundleContent; placeRef: string; base: string; name: string; className: string }) {
  const src = thumbSrc(placeMedia(content, placeRef)[0], base);
  return (
    <span className={className} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element -- file statico del bundle, già ottimizzato */}
      {src ? <img src={src} alt="" loading="lazy" decoding="async" /> : name.slice(0, 1)}
    </span>
  );
}

/**
 * Scheda di un luogo (scelto sulla mappa o nell'elenco, oppure quello in cui ci si trova):
 * galleria con i crediti, descrizione breve dal bundle, distanza in linea d'aria, stato della posizione e azioni.
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
  const media = placeMedia(content, place.ref);
  const verified = place.coordinateStatus === "field_verified";
  return (
    <section className="card place-card" aria-label={place.name}>
      <div className="place-media">
        {props.onClose && (
          <button className="place-close" onClick={props.onClose} aria-label={t.close}>
            <Icon name="close" />
          </button>
        )}
        {media.length > 0 ? (
          <>
            <div className="gallery">
              {media.map((m) => (
                <figure key={m.ref}>
                  {m.kind === "video" ? (
                    // Video ambientale: niente audio, si scarica solo se lo si avvia.
                    <video src={base + m.path} poster={m.poster ? base + m.poster : undefined} muted playsInline controls preload="none" aria-label={m.alt} />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- file statico del bundle, già ottimizzato
                    <img src={base + m.path} alt={m.alt} loading="lazy" decoding="async" />
                  )}
                  {(m.caption || credit(m, t.photo)) && (
                    <figcaption>
                      {m.caption && <span>{m.caption} · </span>}
                      {m.originalUrl ? (
                        <a href={m.originalUrl} target="_blank" rel="noreferrer">
                          {credit(m, t.photo)}
                        </a>
                      ) : (
                        credit(m, t.photo)
                      )}
                    </figcaption>
                  )}
                </figure>
              ))}
            </div>
            {media.length > 1 && <span className="gallery-count">{t.photos(media.filter((m) => m.kind !== "video").length)}{media.some((m) => m.kind === "video") ? " · ▶" : ""}</span>}
          </>
        ) : (
          <div className="no-photo" title={t.noPhoto}>
            <span className="initial" aria-hidden="true">{place.name.slice(0, 1)}</span>
          </div>
        )}
      </div>
      <div className="place-body">
        <p className="eyebrow">
          {isHere ? t.here : d !== null ? `${formatDistance(d, content.locale)} · ${compass(bearingDeg(fix!.location, place.location), t.dirs)}` : " "}
        </p>
        <h2>{place.name}</h2>
        {place.short && <p className="place-short">{place.short}</p>}
        {heard && (
          <span className="heard-mark">
            <Icon name="check" size={18} /> {t.heard}
          </span>
        )}
        <div className="place-actions">
          <button className="button primary big" onClick={props.onListen}>
            <Icon name="play" /> {heard ? t.listenAgain : t.listen}
          </button>
          {canAsk && (
            <button className="button" onClick={props.onAsk}>
              <Icon name="chat" /> {t.askAbout}
            </button>
          )}
          {!isHere && (
            <button className="button" onClick={props.onHere}>
              <Icon name="pin" /> {t.imHere}
            </button>
          )}
        </div>
        <p className={`place-status ${verified ? "good" : ""}`}>
          <span className="dot" />
          {verified ? t.map.verified : place.coordinateStatus === "map_verified" ? t.map.mapVerified : t.map.provisional}
        </p>
      </div>
    </section>
  );
}

/** Prima immagine del luogo, con il credito richiesto dalla licenza (tappa in corso). */
export function PlacePhoto({ content, placeRef, base, label }: { content: BundleContent; placeRef: string; base: string; label: string }) {
  const media = placeMedia(content, placeRef).find((m) => m.kind !== "video") ?? placeMedia(content, placeRef)[0];
  const src = thumbSrc(media, base);
  if (!media || !src) return null;
  const c = credit(media, label);
  return (
    <figure className="place-photo">
      {/* eslint-disable-next-line @next/next/no-img-element -- file statico del bundle, già ottimizzato */}
      <img src={src} alt={media.alt} loading="lazy" decoding="async" />
      {(media.caption || c) && (
        <figcaption>
          {media.caption && <span>{media.caption}</span>}
          {c && (
            <span className="credit">
              {media.originalUrl ? (
                <a href={media.originalUrl} target="_blank" rel="noreferrer">
                  {c}
                </a>
              ) : (
                c
              )}
            </span>
          )}
        </figcaption>
      )}
    </figure>
  );
}
