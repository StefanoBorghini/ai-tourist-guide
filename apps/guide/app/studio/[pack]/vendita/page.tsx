import { requireStaff } from "../../../../lib/studio/server";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../ui";
import { AccessSection } from "./access-section";
import { CatalogSection } from "./catalog-section";

/**
 * Vendita: in una sola pagina cosa è a pagamento (accesso) e cosa si vende a quale prezzo (catalogo).
 * Le regole restano nel database; qui si seguono nell'ordine in cui servono.
 */
export default async function SalePage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ label: pack }]} />
      <PackTabs pack={pack} current="vendita" />
      <h1>Vendita</h1>
      <Notice ok={one(q.ok)} errore={one(q.errore)} />
      <p className="st-hint">
        Due passi: <strong>1.</strong>{" "}scegli cosa è a pagamento; <strong>2.</strong>{" "}crea il prodotto e dagli un prezzo.
        Poi, in Panoramica, «Ripubblica con le modifiche». Tutto il resto dell&apos;app resta gratuito.
      </p>
      <AccessSection pack={pack} session={session} />
      <CatalogSection pack={pack} session={session} />
    </main>
  );
}
