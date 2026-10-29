/**
 * Directory gratuita delle attività locali di una destinazione (versione 1):
 * GET /api/v1/businesses?territory=<pack>&lang=it
 * Lettura pubblica senza cookie né sessione, regole in lib/businesses-api.ts, filtri e campi pubblici decisi dal
 * database (public_local_businesses). Nessuna chiamata AI.
 */
import { NextResponse } from "next/server";
import { businessesReply } from "../../../../lib/businesses-api";
import { publishedOrigin } from "../../../../lib/bundle-index";
import { publicSupabase } from "../../../../lib/public-supabase";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const supabase = publicSupabase();
  const reply = await businessesReply(new URL(request.url).searchParams, supabase ? (args) => supabase.rpc("public_local_businesses", args) : null, publishedOrigin());
  return NextResponse.json(reply.body, { status: reply.status, headers: { "cache-control": reply.cacheControl } });
}
