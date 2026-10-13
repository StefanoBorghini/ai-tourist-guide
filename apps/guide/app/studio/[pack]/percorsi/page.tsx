import Link from "next/link";
import { requireStaff, rpc } from "../../../../lib/studio/server";
import { friendlyError } from "../../../../lib/studio/shared";
import { createRoute } from "../../actions";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../ui";

interface RouteRow {
  slug: string;
  name: string;
  durationMin: number;
  calibration: string;
  stops: number;
}

export default async function RoutesPage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const [{ data, error }, k, places] = await Promise.all([
    rpc<RouteRow[]>(session.supabase, "studio_routes", { p_pack: pack }),
    rpc<{ canEdit: boolean; defaultLocale: string }>(session.supabase, "studio_pack", { p_pack: pack }),
    rpc<{ slug: string; name: string }[]>(session.supabase, "studio_places", { p_pack: pack }),
  ]);
  const routes = data ?? [];
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ label: pack }]} />
      <PackTabs pack={pack} current="percorsi" />
      <h1>Percorsi</h1>
      <Notice ok={one(q.ok)} errore={one(q.errore) ?? (error ? friendlyError(error) : undefined)} />
      {k.data?.canEdit && (
        <details className="st-create" open={routes.length === 0}>
          <summary>Nuovo percorso</summary>
          {(places.data ?? []).length === 0 ? (
            <p className="st-hint">Serve almeno un luogo.</p>
          ) : (
            <form action={createRoute} className="st-form">
              <input type="hidden" name="pack" value={pack} />
              <div className="st-row">
                <label>
                  Nome (it)
                  <input name="name_it" maxLength={120} required={k.data.defaultLocale === "it"} />
                </label>
                <label>
                  Nome (en)
                  <input name="name_en" maxLength={120} required={k.data.defaultLocale === "en"} />
                </label>
                <label>
                  Durata (minuti)
                  <input name="durationMin" type="number" min={5} max={600} defaultValue={45} required />
                </label>
              </div>
              <label>
                Tappe iniziali (l&apos;ordine si sistema dopo)
                <select name="stops" multiple required size={Math.min(6, Math.max(3, (places.data ?? []).length))}>
                  {(places.data ?? []).map((p) => (
                    <option key={p.slug} value={p.slug}>{p.name}</option>
                  ))}
                </select>
              </label>
              <div className="st-actions">
                <button className="st-btn st-primary" type="submit">Crea il percorso</button>
              </div>
            </form>
          )}
        </details>
      )}
      {routes.length === 0 && !error && <p>Nessun percorso in questo territorio.</p>}
      <ul className="st-cards">
        {routes.map((r) => (
          <li key={r.slug}>
            <Link className="st-card" href={`/studio/${encodeURIComponent(pack)}/percorsi/${encodeURIComponent(r.slug)}`}>
              <strong>{r.name}</strong>
              <span className="st-meta">
                {r.slug} · {r.stops} tappe · {r.durationMin} min · {r.calibration === "field_calibrated" ? "calibrato sul posto" : "da calibrare sul posto"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
