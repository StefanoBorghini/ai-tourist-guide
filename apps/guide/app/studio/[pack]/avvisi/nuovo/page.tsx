import { requireStaff, rpc } from "../../../../../lib/studio/server";
import { friendlyError } from "../../../../../lib/studio/shared";
import { newNoticeValues } from "../../../../../lib/studio/operational-notices";
import { territoryToday } from "../../../../../lib/local-events";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../../ui";
import { NoticeForm } from "../NoticeForm";

export default async function NewNoticePage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const [k, places, routes, dest] = await Promise.all([
    rpc<{ canEdit: boolean; locales: string[]; defaultLocale: string; kind: string }>(session.supabase, "studio_pack", { p_pack: pack }),
    rpc<{ slug: string; name: string }[]>(session.supabase, "studio_places", { p_pack: pack }),
    rpc<{ slug: string; name: string }[]>(session.supabase, "studio_routes", { p_pack: pack }),
    session.supabase.from("destinations").select("timezone").eq("pack_id", pack).maybeSingle(),
  ]);
  const base = `/studio/${encodeURIComponent(pack)}/avvisi`;
  const tz = (dest.data as { timezone?: string } | null)?.timezone ?? "Europe/Rome";
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ href: base, label: pack }, { label: "Nuovo avviso" }]} />
      <PackTabs pack={pack} current="avvisi" />
      <h1>Nuovo avviso</h1>
      <Notice errore={one(q.errore) ?? (k.error ? friendlyError(k.error) : undefined)} />
      {!k.data?.canEdit ? (
        <p>Non hai i permessi per gli avvisi di questo territorio.</p>
      ) : k.data.kind !== "destination" ? (
        <p>Gli avvisi appartengono a una destinazione: questo territorio non lo è.</p>
      ) : (
        <>
          <p className="st-hint">L&apos;avviso nasce in bozza. Per pubblicarlo servono la fonte ufficiale e la sua verifica.</p>
          <NoticeForm
            pack={pack}
            values={newNoticeValues(territoryToday(tz))}
            locales={k.data.locales}
            defaultLocale={k.data.defaultLocale}
            places={places.data ?? []}
            routes={routes.data ?? []}
            published={false}
            readOnly={false}
          />
        </>
      )}
    </main>
  );
}
