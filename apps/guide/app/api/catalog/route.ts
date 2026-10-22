/**
 * Listino pubblico di una destinazione per l'app (public_catalog, nessuna sessione necessaria): serve a mostrare
 * prezzo e pulsante d'acquisto accanto ai contenuti a pagamento. Il prezzo è solo informativo: l'importo lo decide
 * il server al checkout. Con account o pagamenti spenti risponde enabled: false.
 */
import { NextResponse } from "next/server";
import { accountClient, accountSetup } from "../../../lib/account/server";
import { paymentsSetup } from "../../../lib/payments/server";
import { PACK_RE } from "../../../lib/payments/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request) {
  const pack = new URL(request.url).searchParams.get("destinazione") ?? "";
  if (!PACK_RE.test(pack) || pack.length > 120) return reply({ enabled: false, items: [] }, 400);
  const account = accountSetup();
  if (!account.ok || !paymentsSetup().ok) return reply({ enabled: false, items: [] });
  const supabase = await accountClient(account.config);
  const { data, error } = await supabase.rpc("public_catalog", { p_pack: pack });
  if (error) return reply({ enabled: true, items: [], error: "catalogo" }, 502);
  return reply({ enabled: true, items: Array.isArray(data) ? data : [] });
}
