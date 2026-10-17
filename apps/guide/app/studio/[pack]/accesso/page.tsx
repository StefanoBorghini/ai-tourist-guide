import { redirect } from "next/navigation";

/** Pagina unita in «Vendita»: i vecchi indirizzi restano validi. */
export default async function Page({ params }: { params: Promise<{ pack: string }> }) {
  const { pack } = await params;
  redirect(`/studio/${encodeURIComponent(pack)}/vendita#accesso`);
}
