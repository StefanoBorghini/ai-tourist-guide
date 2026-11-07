"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { UiText } from "../lib/i18n";
import { canShareFile, isMobileUa, profileUrl, shareCaption, type InstagramShare } from "../lib/share-instagram";
import { Icon } from "./Icon";

/**
 * Invito a raccontare un luogo su Instagram: una riga discreta nella scheda del luogo che apre un foglio dal basso.
 * Instagram non si precompila (lib/share-instagram.ts): il testo si copia con un tocco, la foto passa dal menu
 * «Condividi» del telefono, oppure si apre Instagram e si incolla. Nessun dato esce dall'app senza un tocco del
 * visitatore, e la foto non lascia mai il dispositivo se non verso l'app che sceglie lui.
 */
export function ShareInvite(props: { ig: InstagramShare; placeName: string; destinationName: string; placeUrl: string; t: UiText }) {
  const [open, setOpen] = useState(false);
  const { ig, placeName, t } = props;
  return (
    <>
      <button type="button" className="share-invite" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <Icon name="camera" size={22} />
        <span>
          <strong>{t.share.invite(placeName)}</strong>
          <span className="muted">{t.share.inviteSub(ig.handle)}</span>
        </span>
        <Icon name="forward" size={18} className="share-chevron" />
      </button>
      {/* Nel corpo della pagina: la scheda del luogo non deve limitare il foglio (posizione fissa, sovrapposizioni). */}
      {open && createPortal(<ShareSheet {...props} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

type Source = "photo" | "video" | "gallery";

function ShareSheet({ ig, placeName, destinationName, placeUrl, t, onClose }: Parameters<typeof ShareInvite>[0] & { onClose: () => void }) {
  const caption = shareCaption(ig, placeName, destinationName);
  const [copied, setCopied] = useState<"text" | "link" | "failed" | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [shared, setShared] = useState(false);
  const inputs = useRef<Partial<Record<Source, HTMLInputElement | null>>>({});
  const [source, setSource] = useState<Source>("photo");
  const sheet = useRef<HTMLDivElement>(null);
  // Il menu «Condividi» con un file: c'è sui telefoni (Android, iPhone), quasi mai sui computer.
  const [fileShare, setFileShare] = useState(false);
  const [mobile, setMobile] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const probe = new File([new Uint8Array([0xff, 0xd8, 0xff])], "prova.jpg", { type: "image/jpeg" });
    setFileShare(canShareFile(navigator, probe));
    setMobile(isMobileUa(navigator.userAgent));
    const opener = document.activeElement as HTMLElement | null;
    sheet.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const copy = async (value: string, kind: "text" | "link") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      return true;
    } catch {
      setCopied("failed");
      return false;
    }
  };
  /**
   * Fotocamera (foto o video) o galleria. Sul telefono `capture` apre direttamente la fotocamera posteriore (Android e
   * iPhone); dove non c'è (computer) si sceglie un file. Lo scatto resta sul dispositivo finché non lo si condivide.
   */
  const pick = (source: Source) => {
    // Il testo si copia ora, durante il tocco: dopo lo scatto o la scelta il browser potrebbe non permetterlo più.
    void copy(caption, "text");
    setSource(source);
    inputs.current[source]?.click();
  };
  const onFile = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setShared(false);
    setPreview(f.type.startsWith("image/") ? URL.createObjectURL(f) : null);
    // Subito il menu «Condividi» con lo scatto: si sceglie Instagram e si arriva alla sua pubblicazione. Il browser lo
    // permette solo poco dopo un tocco: dopo la fotocamera può rifiutare, e allora resta il pulsante «Pubblica».
    void share(f);
  };
  const share = async (f: File | null = file) => {
    if (!f) return;
    void copy(caption, "text");
    try {
      // Solo il file: su iOS testo e file insieme possono far perdere il file, e Instagram il testo lo ignora comunque.
      await navigator.share({ files: [f] });
      setShared(true);
    } catch {
      // Menu chiuso dal visitatore o non concesso senza un tocco recente: resta il pulsante per riprovare.
    }
  };

  return (
    <div className="share-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={sheet} className="share-sheet" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <div className="share-head">
          <div>
            <p className="eyebrow">{t.share.eyebrow}</p>
            <h2 id="share-title">{t.share.title(placeName)}</h2>
          </div>
          <button type="button" className="share-close" onClick={onClose} aria-label={t.share.close}>
            <Icon name="close" />
          </button>
        </div>
        <p className="share-body">{t.share.body(ig.handle, destinationName)}</p>

        <figure className="share-caption">
          <figcaption className="muted">{t.share.caption}</figcaption>
          <pre>{caption}</pre>
          <button type="button" className="button small" onClick={() => void copy(caption, "text")}>
            <Icon name={copied === "text" ? "check" : "copy"} size={18} /> {copied === "text" ? t.share.copied : t.share.copy}
          </button>
        </figure>
        {copied === "failed" && <p className="share-note warn" role="status">{t.share.copyFailed}</p>}

        {fileShare && (
          <div className="share-step">
            {(["photo", "video", "gallery"] as const).map((k) => (
              <input
                key={k}
                ref={(el) => { inputs.current[k] = el; }}
                type="file"
                accept={k === "photo" ? "image/*" : k === "video" ? "video/*" : "image/*,video/*"}
                {...(k !== "gallery" ? { capture: "environment" as const } : {})}
                hidden
                data-source={k}
                onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }}
              />
            ))}
            {file ? (
              <div className="share-picked">
                {preview ? <img src={preview} alt="" /> : <span className="share-video"><Icon name="video" /></span>}
                <button type="button" className="button primary big" onClick={() => void share()}>
                  <Icon name="camera" /> {t.share.share}
                </button>
                <button type="button" className="button small" onClick={() => pick(source)}>
                  {source === "gallery" ? t.share.change : t.share.retake}
                </button>
              </div>
            ) : mobile ? (
              <>
                <button type="button" className="button primary big" onClick={() => pick("photo")}>
                  <Icon name="camera" /> {t.share.takePhoto}
                </button>
                <div className="share-row">
                  <button type="button" className="button" onClick={() => pick("video")}>
                    <Icon name="video" size={18} /> {t.share.takeVideo}
                  </button>
                  <button type="button" className="button" onClick={() => pick("gallery")}>
                    <Icon name="image" size={18} /> {t.share.fromGallery}
                  </button>
                </div>
              </>
            ) : (
              <button type="button" className="button primary big" onClick={() => pick("gallery")}>
                <Icon name="image" /> {t.share.pick}
              </button>
            )}
            {(file || shared) && <p className="share-note" role="status">{t.share.sharing}</p>}
          </div>
        )}

        <div className="share-row">
          {/* Dove il telefono passa lo scatto a Instagram non serve: si va diretti alla pubblicazione. */}
          {!fileShare && (
            <a className="button primary" href={profileUrl(ig.handle)} target="_blank" rel="noopener noreferrer" onClick={() => void copy(caption, "text")}>
              <Icon name="external" size={18} /> {t.share.openApp}
            </a>
          )}
          <button type="button" className="button" onClick={() => void copy(placeUrl, "link")}>
            <Icon name={copied === "link" ? "check" : "link"} size={18} /> {copied === "link" ? t.share.linkCopied : t.share.copyLink}
          </button>
        </div>
        <p className="share-note muted">{fileShare || mobile ? t.share.howto(ig.handle) : t.share.desktop}</p>
      </div>
    </div>
  );
}
