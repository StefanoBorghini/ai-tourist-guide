import Link from "next/link";
import { requireStaff, rpc } from "../../../../lib/studio/server";
import { friendlyError } from "../../../../lib/studio/shared";
import { Notice, PackTabs, StudioHeader } from "../../ui";

interface RouteRow {
  slug: string;
  name: string;
  durationMin: number;
  calibration: string;
  stops: number;
}

export default async function RoutesPage({ params }: { params: Promise<{ pack: string }> }) {
  const { pack } = await params;
  const session = await requireStaff();
  const { data, error } = await rpc<RouteRow[]>(session.supabase, "studio_routes", { p_pack: pack });
  const routes = data ?? [];
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ label: pack }]} />
      <PackTabs pack={pack} current="percorsi" />
      <h1>Percorsi</h1>
      <Notice errore={error ? friendlyError(error) : undefined} />
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
