/**
 * Listino pubblico di una destinazione per l'app (public_catalog, nessuna sessione necessaria): serve a mostrare
 * prezzo e pulsante d'acquisto accanto ai contenuti a pagamento. Il prezzo è solo informativo: l'importo lo decide
 * il server al checkout. Con account o pagamenti spenti risponde enabled: false.
 * Con un utente collegato aggiunge i suoi preventivi (my_commerce_quotes: il prezzo con lo sconto per i contenuti che
 * possiede già, calcolato dal database con la sua sessione) e i contenuti che possiede.
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
  const items = Array.isArray(data) ? data : [];
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return reply({ enabled: true, items, quotes: [], ownedUnits: [] });
  // Senza preventivi (migrazione non ancora applicata o errore) l'app mostra il listino: il checkout ricalcola comunque.
  const { data: mine } = await supabase.rpc("my_commerce_quotes", { p_pack: pack });
  const quotes = Array.isArray(mine?.quotes) ? mine.quotes : [];
  const ownedUnits = Array.isArray(mine?.ownedUnits) ? mine.ownedUnits : [];
  return reply({ enabled: true, items, quotes, ownedUnits });
}
