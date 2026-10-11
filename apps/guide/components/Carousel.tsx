"use client";

/**
 * Carosello orizzontale: si scorre col dito (snap su ogni scheda) e, con mouse o tastiera, con le frecce.
 * Le frecce compaiono solo se c'è altro da vedere da quel lato; i bordi sfumano dove il contenuto continua.
 * Resta nella sua colonna: non invade il pannello accanto.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

export function Carousel({ children, label, prevLabel, nextLabel, className = "" }: {
  children: ReactNode;
  label: string;
  prevLabel: string;
  nextLabel: string;
  className?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const update = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ start: el.scrollLeft <= 2, end: el.scrollLeft >= max - 2 });
  }, []);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [update, children]);

  const move = (dir: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    const tile = el.firstElementChild as HTMLElement | null;
    const gap = parseFloat(getComputedStyle(el).columnGap) || 12;
    // Una "pagina" di schede intere: quante ne stanno, almeno una.
    const step = tile ? Math.max(1, Math.floor(el.clientWidth / (tile.offsetWidth + gap))) * (tile.offsetWidth + gap) : el.clientWidth * 0.85;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: dir * step, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <div className={`carousel-wrap ${edges.start ? "" : "more-start"} ${edges.end ? "" : "more-end"}`}>
      <div ref={track} className={`carousel ${className}`} role="list" aria-label={label}>
        {children}
      </div>
      {!edges.start && (
        <button type="button" className="carousel-arrow prev" aria-label={prevLabel} onClick={() => move(-1)}>
          <Icon name="back" size={18} />
        </button>
      )}
      {!edges.end && (
        <button type="button" className="carousel-arrow next" aria-label={nextLabel} onClick={() => move(1)}>
          <Icon name="forward" size={18} />
        </button>
      )}
    </div>
  );
}
