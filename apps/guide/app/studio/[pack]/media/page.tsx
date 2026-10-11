import Link from "next/link";
import { requireStaff, rpc, signedMediaUrls } from "../../../../lib/studio/server";
import { deleteHref, friendlyError } from "../../../../lib/studio/shared";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../ui";
import { MediaUploader } from "./MediaUploader";

interface MediaRow {
  slug: string;
  kind: string;
  path: string;
  poster: string | null;
  alt: string | null;
  author: string | null;
  license: string;
  source: string;
  bytes: number | null;
  cover: boolean;
  subjects: string[];
}

interface PackRow {
  id: string;
  canEdit: boolean;
}

export default async function MediaPage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const [{ data, error }, places, packs] = await Promise.all([
    rpc<MediaRow[]>(session.supabase, "studio_media", { p_pack: pack }),
    rpc<{ slug: string; name: string }[]>(session.supabase, "studio_places", { p_pack: pack }),
    rpc<PackRow[]>(session.supabase, "studio_packs"),
  ]);
  const media = data ?? [];
  const urls = await signedMediaUrls(session.supabase, media.map((m) => (m.kind === "video" ? (m.poster ?? "") : m.path)));
  const canEdit = !!packs.data?.find((p) => p.id === pack)?.canEdit;
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ label: pack }]} />
      <PackTabs pack={pack} current="media" />
      <h1>Foto</h1>
      <p className="st-hint">
        Gli originali stanno nel bucket privato «media» di Supabase, nella cartella del territorio; qui si vedono con indirizzi
        temporanei. Ogni foto entra con autore, licenza e provenienza dichiarati, come nei Territory Pack.
      </p>
      <Notice ok={one(q.ok)} errore={one(q.errore) ?? (error ? friendlyError(error) : undefined)} />
      {canEdit && session.config && (
        <MediaUploader pack={pack} config={session.config} places={(places.data ?? []).map((p) => ({ slug: p.slug, name: p.name }))} />
      )}
      <ul className="st-thumbs st-thumbs-lg">
        {media.map((m) => {
          const src = urls.get(m.kind === "video" ? (m.poster ?? "") : m.path);
          return (
            <li key={m.slug}>
              {src ? (
                // eslint-disable-next-line @next/next/no-img-element -- indirizzo temporaneo del bucket privato
                <img src={src} alt={m.alt ?? ""} loading="lazy" />
              ) : (
                <span className="st-nofile">file non ancora nel bucket</span>
              )}
              <span className="st-meta">
                <strong>{m.slug}</strong>
                {m.kind === "video" ? " · video" : ""}
                {m.cover ? " · copertina" : ""}
              </span>
              <span className="st-meta">{m.subjects.join(", ")}</span>
              <span className="st-meta">
                {m.author ?? "—"} · {m.license} · {m.source}
                {m.bytes ? ` · ${(m.bytes / 1024 / 1024).toFixed(1)} MB` : ""}
              </span>
              {canEdit && <Link className="st-delete-link" href={deleteHref(pack, "media", m.slug)}>Elimina…</Link>}
            </li>
          );
        })}
      </ul>
      {media.length === 0 && !error && <p>Nessuna foto per questo territorio.</p>}
    </main>
  );
}
