import Link from "next/link";
import { requireStaff, rpc } from "../../../../lib/studio/server";
import { COORDINATE_LABELS, friendlyError } from "../../../../lib/studio/shared";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../ui";

interface PlaceRow {
  slug: string;
  name: string;
  placeKind: string;
  categories: string[];
  importance: number;
  coordinateStatus: string;
  media: number;
}

export default async function PlacesPage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const [{ data, error }, k] = await Promise.all([
    rpc<PlaceRow[]>(session.supabase, "studio_places", { p_pack: pack }),
    rpc<{ canEdit: boolean }>(session.supabase, "studio_pack", { p_pack: pack }),
  ]);
  const places = data ?? [];
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ label: pack }]} />
      <PackTabs pack={pack} current="luoghi" />
      <div className="st-titlebar">
        <h1>Luoghi</h1>
        {k.data?.canEdit && (
          <Link className="st-btn st-primary" href={`/studio/${encodeURIComponent(pack)}/luoghi/nuovo`}>
            Nuovo luogo
          </Link>
        )}
      </div>
      <Notice ok={one(q.ok)} errore={one(q.errore) ?? (error ? friendlyError(error) : undefined)} />
      {places.length === 0 && !error && <p>Nessun luogo visibile per questo territorio.</p>}
      <table className="st-table">
        <thead>
          <tr>
            <th>Luogo</th>
            <th>Categorie</th>
            <th>Importanza</th>
            <th>Coordinate</th>
            <th>Foto</th>
          </tr>
        </thead>
        <tbody>
          {places.map((p) => (
            <tr key={p.slug}>
              <td>
                <Link href={`/studio/${encodeURIComponent(pack)}/luoghi/${encodeURIComponent(p.slug)}`}>{p.name}</Link>
                <span className="st-meta">{p.slug}</span>
              </td>
              <td>{p.categories.join(", ")}</td>
              <td>{p.importance}</td>
              <td>
                <span className={`st-status st-coord-${p.coordinateStatus}`}>{COORDINATE_LABELS[p.coordinateStatus] ?? p.coordinateStatus}</span>
              </td>
              <td>{p.media}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
