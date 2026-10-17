import Link from "next/link";
import { requireStaff, rpc } from "../../lib/studio/server";
import { friendlyError, STATUS_LABELS } from "../../lib/studio/shared";
import { KIND_LABELS, Notice, one, PackStatus, StudioHeader, type SearchParams } from "./ui";

interface PackRow {
  id: string;
  kind: string;
  status: string | null;
  dependsOn: string[];
  units: number;
  title: Record<string, string>;
  version: string;
  releaseStage: string;
  places: number;
  routes: number;
  media: number;
  assertions: Record<string, number>;
  canEdit: boolean;
  canVerify: boolean;
}

export default async function StudioHome({ searchParams }: { searchParams: SearchParams }) {
  const q = await searchParams;
  const session = await requireStaff();
  const [{ data, error }, scopes] = await Promise.all([
    rpc<PackRow[]>(session.supabase, "studio_packs"),
    rpc<{ anywhere: boolean; scopes: string[] }>(session.supabase, "studio_creation_scopes"),
  ]);
  const packs = data ?? [];
  const canCreate = !!scopes.data && (scopes.data.anywhere || scopes.data.scopes.length > 0);
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[]} />
      <div className="st-titlebar">
        <h1>Territori</h1>
        {canCreate && (
          <Link className="st-btn st-primary" href="/studio/nuovo">
            Nuovo territorio
          </Link>
        )}
      </div>
      <p className="st-hint">
        Le modifiche fatte qui restano nel database della redazione: arrivano nell'app solo con la pubblicazione (prossima fase).
      </p>
      <Notice ok={one(q.ok)} errore={one(q.errore) ?? (error ? friendlyError(error) : undefined)} />
      {packs.length === 0 && !error && <p>Nessun territorio assegnato al tuo account.</p>}
      <ul className="st-cards">
        {packs.map((p) => (
          <li key={p.id}>
            <Link className="st-card" href={`/studio/${encodeURIComponent(p.id)}`}>
              <span className="st-card-head">
                <strong>{p.title.it ?? p.title.en ?? p.id}</strong>
                <PackStatus status={p.status} />
              </span>
              <span className="st-meta">
                {p.id} · {KIND_LABELS[p.kind] ?? p.kind} · {p.version} · {p.releaseStage}
                {p.dependsOn.length ? ` · dentro ${p.dependsOn.join(", ")}` : ""}
              </span>
              <span className="st-meta">
                {p.places} luoghi · {p.units} racconti · {p.routes} percorsi · {p.media} foto
              </span>
              <span className="st-meta">
                {Object.entries(p.assertions).map(([s, n]) => `${n} ${STATUS_LABELS[s]?.toLowerCase() ?? s}`).join(" · ") || "nessun fatto"}
              </span>
              <span className="st-badges">
                {p.canEdit && <span className="st-badge">modifica</span>}
                {p.canVerify && <span className="st-badge">verifica</span>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
