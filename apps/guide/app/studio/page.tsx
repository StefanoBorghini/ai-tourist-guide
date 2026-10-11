import Link from "next/link";
import { requireStaff, rpc } from "../../lib/studio/server";
import { friendlyError, STATUS_LABELS } from "../../lib/studio/shared";
import { Notice, StudioHeader } from "./ui";

interface PackRow {
  id: string;
  kind: string;
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

export default async function StudioHome() {
  const session = await requireStaff();
  const { data, error } = await rpc<PackRow[]>(session.supabase, "studio_packs");
  const packs = data ?? [];
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[]} />
      <h1>Territori</h1>
      <p className="st-hint">
        Le modifiche fatte qui restano nel database della redazione: arrivano nell'app solo con la pubblicazione (prossima fase).
      </p>
      <Notice errore={error ? friendlyError(error) : undefined} />
      {packs.length === 0 && !error && <p>Nessun territorio assegnato al tuo account.</p>}
      <ul className="st-cards">
        {packs.map((p) => (
          <li key={p.id}>
            <Link className="st-card" href={`/studio/${encodeURIComponent(p.id)}`}>
              <strong>{p.title.it ?? p.title.en ?? p.id}</strong>
              <span className="st-meta">
                {p.id} · {p.kind} · {p.version} · {p.releaseStage}
              </span>
              <span className="st-meta">
                {p.places} luoghi · {p.routes} percorsi · {p.media} foto
              </span>
              <span className="st-meta">
                {Object.entries(p.assertions).map(([s, n]) => `${n} ${STATUS_LABELS[s]?.toLowerCase() ?? s}`).join(" · ") || "nessuna affermazione"}
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
