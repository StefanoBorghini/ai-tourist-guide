import { requireStaff, rpc } from "../../../../../lib/studio/server";
import { friendlyError } from "../../../../../lib/studio/shared";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../../ui";
import { BusinessForm } from "../BusinessForm";

export default async function NewBusinessPage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const k = await rpc<{ canEdit: boolean; locales: string[]; defaultLocale: string; kind: string }>(session.supabase, "studio_pack", { p_pack: pack });
  const base = `/studio/${encodeURIComponent(pack)}/attivita`;
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ href: base, label: pack }, { label: "Nuova attività" }]} />
      <PackTabs pack={pack} current="attivita" />
      <h1>Nuova attività</h1>
      <Notice errore={one(q.errore) ?? (k.error ? friendlyError(k.error) : undefined)} />
      {!k.data?.canEdit ? (
        <p>Non hai i permessi per le attività di questo territorio.</p>
      ) : k.data.kind !== "destination" ? (
        <p>Le attività appartengono a una destinazione: questo territorio non lo è.</p>
      ) : (
        <>
          <p className="st-hint">L&apos;attività nasce in bozza. Per pubblicarla serve la verifica dei dati.</p>
          <BusinessForm pack={pack} values={{}} locales={k.data.locales} defaultLocale={k.data.defaultLocale} published={false} readOnly={false} />
        </>
      )}
    </main>
  );
}
