import Link from "next/link";
import { requireStaff, rpc } from "../../../lib/studio/server";
import { Notice, one, StudioHeader, type SearchParams } from "../ui";
import { NewPackForm } from "./NewPackForm";

interface Scopes {
  anywhere: boolean;
  scopes: string[];
  organizations: { id: string; name: string }[];
  admin: boolean;
}

export default async function NewTerritoryPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await searchParams;
  const session = await requireStaff();
  const [scopes, packs] = await Promise.all([
    rpc<Scopes>(session.supabase, "studio_creation_scopes"),
    rpc<{ id: string; kind: string; title: Record<string, string> }[]>(session.supabase, "studio_packs"),
  ]);
  const s = scopes.data;
  const canCreate = !!s && (s.anywhere || s.scopes.length > 0);
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ label: "Nuovo territorio" }]} />
      <h1>Nuovo territorio</h1>
      <p className="st-hint">
        Il territorio nasce in bozza e nel database della redazione: non compare nell'app finché non viene pubblicato con la
        pipeline di pubblicazione. Identificativo e tipologia non si cambiano dopo la creazione.
      </p>
      <Notice errore={one(q.errore)} />
      {!canCreate ? (
        <p>
          Il tuo ruolo non permette di creare territori. <Link href="/studio">Torna ai territori</Link>
        </p>
      ) : (
        <NewPackForm
          anywhere={s!.anywhere}
          scopes={s!.scopes}
          admin={s!.admin}
          organizations={s!.organizations}
          parents={(packs.data ?? []).map((p) => ({ id: p.id, name: p.title.it ?? p.title.en ?? p.id, kind: p.kind }))}
        />
      )}
    </main>
  );
}
