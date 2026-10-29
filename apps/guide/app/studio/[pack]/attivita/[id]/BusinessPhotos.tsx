"use client";
/**
 * Foto di un'attività nello Studio (migrazione 20261106000000): come le foto dei luoghi, con autore, licenza e
 * provenienza dichiarati. Il file va dal browser al bucket pubblico «business-photos» con la sessione dell'utente
 * (le policy ammettono solo la cartella di un'attività dei territori che può modificare), ridotto e senza EXIF; poi
 * il server lo registra. Se la registrazione fallisce, il file appena caricato si toglie.
 * Elenco con «Metti per prima» (la copertina nella guida) ed «Elimina» (registrazione e file).
 */
import { createBrowserClient } from "@supabase/ssr";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { LICENSE_LABELS, reduceImage, SOURCE_LABELS } from "../../../../../lib/studio/image-upload";
import {
  BUSINESS_PHOTO_LICENSES, BUSINESS_PHOTOS_BUCKET, businessPhotoPath, businessPhotoPublicUrl, MAX_BUSINESS_PHOTO_BYTES,
  MAX_BUSINESS_PHOTOS, type StudioBusinessPhoto,
} from "../../../../../lib/studio/local-businesses";
import { checkImage, checkMediaRights, MEDIA_SOURCES, storageFileName, type StudioConfig } from "../../../../../lib/studio/shared";
import { addBusinessPhoto, deleteBusinessPhoto, firstBusinessPhoto } from "../../../actions-businesses";

/** Suffisso casuale del nome del file: un file di una bozza non si raggiunge senza conoscerlo. */
const randomSuffix = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function BusinessPhotos({ pack, business, photos, config, canEdit }: {
  pack: string;
  business: string;
  photos: StudioBusinessPhoto[];
  config: StudioConfig | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok?: string; error?: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const full = photos.length >= MAX_BUSINESS_PHOTOS;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!config) return;
    const data = new FormData(e.currentTarget);
    const chosen = data.get("file");
    if (!(chosen instanceof File) || chosen.size === 0) return setMessage({ error: "Scegli un'immagine." });
    const problem = checkImage(chosen);
    if (problem) return setMessage({ error: problem });
    const field = (name: string) => String(data.get(name) ?? "");
    const rights = checkMediaRights({
      author: field("author"), license: field("license"), source: field("source"), originalUrl: field("originalUrl"), licenseNote: field("licenseNote"),
    });
    if (rights) return setMessage({ error: rights });
    if (!field("altIt").trim()) return setMessage({ error: "Scrivi il testo alternativo: cosa si vede nella foto." });

    setBusy(true);
    setMessage(null);
    try {
      const file = await reduceImage(chosen);
      if (file.size > MAX_BUSINESS_PHOTO_BYTES) {
        setMessage({ error: `Anche ridotta, la foto supera ${MAX_BUSINESS_PHOTO_BYTES / 1024 / 1024} MB: scegline una più leggera.` });
        return;
      }
      const supabase = createBrowserClient(config.url, config.anonKey);
      const path = businessPhotoPath(pack, business, storageFileName(file.name, file.type, randomSuffix()));
      const upload = await supabase.storage.from(BUSINESS_PHOTOS_BUCKET).upload(path, file, { contentType: file.type, upsert: false, cacheControl: "86400" });
      if (upload.error) {
        setMessage({ error: `Caricamento non riuscito: ${upload.error.message}` });
        return;
      }
      const result = await addBusinessPhoto({
        pack, business, path,
        altIt: field("altIt"), altEn: field("altEn"), author: field("author"), license: field("license"), source: field("source"),
        originalUrl: field("originalUrl"), licenseNote: field("licenseNote"),
      });
      if (result.error) {
        await supabase.storage.from(BUSINESS_PHOTOS_BUCKET).remove([path]);
        setMessage({ error: result.error });
        return;
      }
      setMessage({ ok: "Foto caricata: compare nella guida se l'attività è pubblicata." });
      form.current?.reset();
      setPreview(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const hidden = (photo: string) => (
    <>
      <input type="hidden" name="pack" value={pack} />
      <input type="hidden" name="id" value={business} />
      <input type="hidden" name="photo" value={photo} />
    </>
  );

  return (
    <section className="st-panel" aria-labelledby="foto">
      <h2 id="foto">Foto</h2>
      <p className="st-hint">
        Fino a {MAX_BUSINESS_PHOTOS} foto, con autore e licenza come per i luoghi (mai «tutti i diritti riservati»). La prima è la copertina
        nella guida. Usa foto tue o concesse dall&apos;attività per iscritto; non prendere immagini dal web senza licenza.
      </p>
      {photos.length === 0 ? (
        <p className="st-hint">Nessuna foto.</p>
      ) : (
        <ul className="st-photos">
          {photos.map((f, i) => (
            <li key={f.id}>
              {config && (
                // eslint-disable-next-line @next/next/no-img-element -- anteprima dal bucket pubblico
                <img src={businessPhotoPublicUrl(config.url, f.path)} alt={f.alt.it ?? ""} loading="lazy" />
              )}
              <span className="st-meta">
                {i === 0 && <strong>Copertina · </strong>}
                {f.alt.it}
                <br />
                {[f.author, LICENSE_LABELS[f.license] ?? f.license, SOURCE_LABELS[f.source] ?? f.source].filter(Boolean).join(" · ")}
              </span>
              {canEdit && (
                <span className="st-actions">
                  {i > 0 && (
                    <form action={firstBusinessPhoto}>
                      {hidden(f.id)}
                      <button className="st-btn st-quiet" type="submit">Metti per prima</button>
                    </form>
                  )}
                  <form action={deleteBusinessPhoto}>
                    {hidden(f.id)}
                    <button className="st-btn st-danger" type="submit">Elimina</button>
                  </form>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && !config && <p className="st-hint">Caricamento non disponibile: Supabase non è configurato.</p>}
      {canEdit && config && full && <p className="st-hint">Hai raggiunto le {MAX_BUSINESS_PHOTOS} foto: eliminane una per caricarne un&apos;altra.</p>}
      {canEdit && config && !full && (
        <form ref={form} onSubmit={submit} className="st-form st-upload" aria-label="Carica una foto dell'attività">
          <div className="st-row">
            <label>
              Immagine (JPEG, PNG o WebP)
              <input
                name="file"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                required
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  setPreview(f ? URL.createObjectURL(f) : null);
                }}
              />
            </label>
            {/* eslint-disable-next-line @next/next/no-img-element -- anteprima locale prima del caricamento */}
            {preview && <img className="st-preview" src={preview} alt="" />}
          </div>
          <div className="st-row">
            <label>
              Testo alternativo (it)
              <input name="altIt" required maxLength={300} placeholder="Cosa si vede, per chi non vede l'immagine" />
            </label>
            <label>
              Testo alternativo (en)
              <input name="altEn" maxLength={300} />
            </label>
          </div>
          <div className="st-row">
            <label>
              Autore (obbligatorio salvo pubblico dominio)
              <input name="author" maxLength={200} placeholder="Nome e cognome, o l'attività" />
            </label>
            <label>
              Licenza
              <select name="license" defaultValue="own" required>
                {BUSINESS_PHOTO_LICENSES.map((l) => <option key={l} value={l}>{LICENSE_LABELS[l] ?? l}</option>)}
              </select>
            </label>
            <label>
              Provenienza
              <select name="source" defaultValue="own_photo" required>
                {MEDIA_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABELS[s] ?? s}</option>)}
              </select>
            </label>
          </div>
          <div className="st-row">
            <label>
              Indirizzo originale (obbligatorio se dal web)
              <input name="originalUrl" type="url" maxLength={500} />
            </label>
            <label>
              Riferimento all&apos;accordo (per licenze concesse per iscritto)
              <input name="licenseNote" maxLength={500} placeholder="es. autorizzazione scritta del titolare, 20/10/2026" />
            </label>
          </div>
          <div className="st-actions">
            <button className="st-btn st-primary" type="submit" disabled={busy}>{busy ? "Caricamento…" : "Carica la foto"}</button>
          </div>
          {message?.error && <p className="st-notice st-error" role="alert">{message.error}</p>}
          {message?.ok && <p className="st-notice st-ok" role="status">{message.ok}</p>}
        </form>
      )}
    </section>
  );
}
