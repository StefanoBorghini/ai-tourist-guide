"use client";

import { useEffect, useState } from "react";
import type { UiText } from "../lib/i18n";
import { Icon } from "./Icon";

/** Evento di Chrome/Edge/Android per l'installazione della PWA (non è nei tipi standard del DOM). */
interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type Kind = "native" | "ios" | "other";

const SESSION_KEY = "guide-install-later";

/**
 * Invito a installare l'app, a ogni apertura finché non è installata. «Non ora» lo chiude solo per questa sessione.
 * Dove il browser lo permette (Android, Chrome, Edge) il pulsante apre l'installazione vera; su iPhone e iPad
 * (Safari non lo permette) spiega i due tocchi da fare.
 */
export function InstallPrompt({ t, hidden = false }: { t: UiText; hidden?: boolean }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [event, setEvent] = useState<InstallEvent | null>(null);

  useEffect(() => {
    const installed =
      window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    let later = false;
    try {
      later = sessionStorage.getItem(SESSION_KEY) === "1";
    } catch {
      // Archiviazione non disponibile: l'invito compare comunque.
    }
    if (installed || later) return;
    const ua = navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as InstallEvent);
      setKind("native");
    };
    const onInstalled = () => setKind(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    // Senza l'evento del browser (Safari, Firefox) si mostrano le istruzioni, dopo un attimo.
    const timer = window.setTimeout(() => setKind((k) => k ?? (ios ? "ios" : "other")), 2500);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      window.clearTimeout(timer);
    };
  }, []);

  if (!kind || hidden) return null;
  const close = () => {
    try {
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      // Niente: si chiude solo per questa pagina.
    }
    setKind(null);
  };
  const install = async () => {
    if (!event) return;
    await event.prompt();
    const choice = await event.userChoice.catch(() => null);
    setEvent(null);
    if (choice?.outcome === "accepted") setKind(null);
    else close();
  };

  return (
    <div className="install-sheet" role="dialog" aria-modal="false" aria-labelledby="install-title">
      <div className="install-head">
        <span className="install-icon" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element -- icona dell'app */}
          <img src="/icon.svg" alt="" width={40} height={40} />
        </span>
        <div>
          <strong id="install-title">{t.installTitle}</strong>
          <p className="muted small">{t.installLead}</p>
        </div>
        <button className="install-close" onClick={close} aria-label={t.close}>
          <Icon name="close" />
        </button>
      </div>
      {kind === "native" ? (
        <button className="button primary big block" onClick={install}>
          <Icon name="download" /> {t.installButton}
        </button>
      ) : kind === "ios" ? (
        <ol className="install-steps">
          <li>{t.installIosShare}</li>
          <li>{t.installIosAdd}</li>
        </ol>
      ) : (
        <p className="small">{t.installOther}</p>
      )}
      <button className="button quiet block" onClick={close}>{t.installLater}</button>
    </div>
  );
}
