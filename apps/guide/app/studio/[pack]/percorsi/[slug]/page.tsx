import { requireStaff, rpc } from "../../../../../lib/studio/server";
import { friendlyError, type Stop } from "../../../../../lib/studio/shared";
import { Notice, PackTabs, StudioHeader } from "../../../ui";
import { StopsEditor } from "./StopsEditor";

interface RouteDetail {
  slug: string;
  labels: Record<string, { name: string }>;
  durationMin: number;
  calibration: string;
  difficulty: string | null;
  notes: string[];
  stops: Stop[];
  places: { place: string; name: string }[];
  canEdit: boolean;
}

export default async function RoutePage({ params }: { params: Promise<{ pack: string; slug: string }> }) {
  const { pack, slug } = await params;
  const session = await requireStaff();
  const { data: route, error } = await rpc<RouteDetail>(session.supabase, "studio_route", { p_pack: pack, p_slug: slug });
  const base = `/studio/${encodeURIComponent(pack)}`;
  const name = route?.labels.it?.name ?? route?.labels.en?.name ?? slug;
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ href: `${base}/percorsi`, label: pack }, { label: name }]} />
      <PackTabs pack={pack} current="percorsi" />
      {!route ? (
        <Notice errore={error ? friendlyError(error) : "Percorso non trovato o non visibile con il tuo ruolo."} />
      ) : (
        <>
          <h1>{name}</h1>
          <p className="st-meta">
            {slug} · {route.durationMin} min{route.difficulty ? ` · ${route.difficulty}` : ""} ·{" "}
            {route.calibration === "field_calibrated" ? "calibrato sul posto" : "da calibrare sul posto"}
          </p>
          {route.calibration === "field_calibrated" && (
            <p className="st-hint">Se cambi le tappe il percorso torna «da calibrare»: tempi e distanze vanno rimisurati sul posto.</p>
          )}
          {route.notes.length > 0 && (
            <ul className="st-notes">
              {route.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <StopsEditor pack={pack} slug={slug} initial={route.stops} places={route.places} canEdit={route.canEdit} />
        </>
      )}
    </main>
  );
}
