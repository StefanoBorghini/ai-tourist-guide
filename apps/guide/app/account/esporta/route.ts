/**
 * GET /account/esporta — i dati dell'account in un file JSON (diritto di accesso): profilo, consensi, diritti
 * (export_my_data, con l'identità dell'utente) più i dati dell'accesso. Mai in cache.
 */
import { NextResponse } from "next/server";
import { requireVisitor } from "../../../lib/account/server";

export async function GET() {
  const { supabase, user } = await requireVisitor("/account");
  const { data, error } = await supabase.rpc("export_my_data");
  if (error) {
    console.error(JSON.stringify({ event: "account_export_error", code: error.code }));
    return NextResponse.json({ error: "esportazione non riuscita" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
  const account = {
    email: user.email ?? null,
    created_at: user.created_at,
    last_sign_in_at: user.last_sign_in_at ?? null,
    sign_in_methods: [...new Set((user.identities ?? []).map((i) => i.provider))],
  };
  const day = new Date().toISOString().slice(0, 10);
  return new NextResponse(JSON.stringify({ exported_at: new Date().toISOString(), account, ...(data as object) }, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="ai-guide-dati-${day}.json"`,
      "cache-control": "no-store",
    },
  });
}
