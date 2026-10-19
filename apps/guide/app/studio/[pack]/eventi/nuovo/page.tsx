import { requireStaff, rpc } from "../../../../../lib/studio/server";
import { friendlyError } from "../../../../../lib/studio/shared";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../../ui";
import { EventForm } from "../EventForm";

export default async function NewEventPage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const [k, places] = await Promise.all([
    rpc<{ canEdit: boolean; locales: string[]; defaultLocale: string; kind: string }>(session.supabase, "studio_pack", { p_pack: pack }),
    rpc<{ slug: string; name: string }[]>(session.supabase, "studio_places", { p_pack: pack }),
  ]);
  const base = `/studio/${encodeURIComponent(pack)}/eventi`;
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ href: base, label: pack }, { label: "Nuovo evento" }]} />
      <PackTabs pack={pack} current="eventi" />
      <h1>Nuovo evento</h1>
      <Notice errore={one(q.errore) ?? (k.error ? friendlyError(k.error) : undefined)} />
      {!k.data?.canEdit ? (
        <p>Non hai i permessi per gli eventi di questo territorio.</p>
      ) : k.data.kind !== "destination" ? (
        <p>Gli eventi appartengono a una destinazione: questo territorio non lo è.</p>
      ) : (
        <>
          <p className="st-hint">L&apos;evento nasce in bozza. Per pubblicarlo servono la fonte ufficiale e la sua verifica.</p>
          <EventForm pack={pack} values={{}} locales={k.data.locales} defaultLocale={k.data.defaultLocale} places={places.data ?? []} published={false} readOnly={false} />
        </>
      )}
    </main>
  );
}
