"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { checkImage, checkMediaRights, MEDIA_BUCKET, MEDIA_LICENSES, MEDIA_SOURCES, storageFileName, type StudioConfig } from "../../../../lib/studio/shared";
import { registerMedia } from "../../actions";

const LICENSE_LABELS: Record<string, string> = {
  own: "Nostra (diritti propri)",
  "public-domain": "Pubblico dominio",
  cc0: "CC0",
  "cc-by-4.0": "CC BY 4.0",
  "cc-by-sa-4.0": "CC BY-SA 4.0",
  "cc-by-nc-4.0": "CC BY-NC 4.0 (non commerciale)",
  "cc-by-nc-sa-4.0": "CC BY-NC-SA 4.0 (non commerciale)",
  licensed: "Concessa per iscritto",
  "all-rights-reserved": "Tutti i diritti riservati (non pubblicabile)",
};
const SOURCE_LABELS: Record<string, string> = {
  own_photo: "Foto nostra",
  institution: "Ente o istituzione",
  archive: "Archivio",
  web: "Web (con indirizzo originale)",
  other: "Altro",
};

async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Caricamento di una foto: il file va dal browser al bucket «media» con la sessione dell'utente
 * (le policy di Storage ammettono solo la cartella dei territori che può modificare), poi il server
 * registra i metadati. Se la registrazione fallisce, il file appena caricato si toglie.
 */
export function MediaUploader({ pack, config, places }: { pack: string; config: StudioConfig; places: { slug: string; name: string }[] }) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok?: string; error?: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) return setMessage({ error: "Scegli un'immagine." });
    const problem = checkImage(file);
    if (problem) return setMessage({ error: problem });
    const subjects = data.getAll("subjects").map(String);
    if (subjects.length === 0) return setMessage({ error: "Indica almeno un luogo raffigurato." });
    const rights = checkMediaRights({
      author: String(data.get("author") ?? ""),
      license: String(data.get("license") ?? ""),
      source: String(data.get("source") ?? ""),
      originalUrl: String(data.get("originalUrl") ?? ""),
      licenseNote: String(data.get("licenseNote") ?? ""),
    });
    if (rights) return setMessage({ error: rights });

    setBusy(true);
    setMessage(null);
    const supabase = createBrowserClient(config.url, config.anonKey);
    const name = storageFileName(file.name, file.type, Date.now().toString(36));
    const path = `${pack}/${name}`;
    try {
      const upload = await supabase.storage.from(MEDIA_BUCKET).upload(path, file, { contentType: file.type, upsert: false, cacheControl: "3600" });
      if (upload.error) {
        setMessage({ error: `Caricamento non riuscito: ${upload.error.message}` });
        return;
      }
      const result = await registerMedia({
        pack,
        file: name,
        sha256: await sha256(file),
        mimeType: file.type,
        bytes: file.size,
        altIt: String(data.get("altIt") ?? ""),
        altEn: String(data.get("altEn") ?? ""),
        captionIt: String(data.get("captionIt") ?? ""),
        author: String(data.get("author") ?? ""),
        license: String(data.get("license") ?? ""),
        source: String(data.get("source") ?? ""),
        originalUrl: String(data.get("originalUrl") ?? ""),
        licenseNote: String(data.get("licenseNote") ?? ""),
        subjects,
      });
      if (result.error) {
        await supabase.storage.from(MEDIA_BUCKET).remove([path]);
        setMessage({ error: result.error });
        return;
      }
      setMessage({ ok: "Foto caricata e registrata." });
      form.current?.reset();
      setPreview(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form ref={form} onSubmit={submit} className="st-form st-upload" aria-label="Carica una foto">
      <h2>Carica una foto</h2>
      <div className="st-row">
        <label>
          Immagine (JPEG, PNG o WebP, max 15 MB)
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
      <label>
        Luoghi raffigurati
        <select name="subjects" multiple required size={Math.min(6, Math.max(3, places.length))}>
          {places.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
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
      <label>
        Didascalia (it, facoltativa)
        <input name="captionIt" maxLength={300} />
      </label>
      <div className="st-row">
        <label>
          Autore (obbligatorio salvo pubblico dominio)
          <input name="author" maxLength={200} placeholder="Nome e cognome o ente" />
        </label>
        <label>
          Licenza
          <select name="license" defaultValue="own" required>
            {MEDIA_LICENSES.map((l) => (
              <option key={l} value={l}>
                {LICENSE_LABELS[l] ?? l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Provenienza
          <select name="source" defaultValue="own_photo" required>
            {MEDIA_SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABELS[s] ?? s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="st-row">
        <label>
          Indirizzo originale (obbligatorio se dal web)
          <input name="originalUrl" type="url" maxLength={500} />
        </label>
        <label>
          Riferimento all'accordo (per licenze concesse per iscritto)
          <input name="licenseNote" maxLength={500} />
        </label>
      </div>
      <div className="st-actions">
        <button className="st-btn st-primary" type="submit" disabled={busy}>
          {busy ? "Caricamento…" : "Carica e registra"}
        </button>
      </div>
      {message?.error && <p className="st-notice st-error" role="alert">{message.error}</p>}
      {message?.ok && <p className="st-notice st-ok" role="status">{message.ok}</p>}
    </form>
  );
}
