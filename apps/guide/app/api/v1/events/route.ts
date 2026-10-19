/**
 * Eventi del giorno di una destinazione, per l'app e per i servizi futuri (versione 1):
 * GET /api/v1/events?territory=<pack>&from=AAAA-MM-GG&to=AAAA-MM-GG&lang=it
 * Lettura pubblica senza cookie né sessione (lib/public-supabase.ts), regole in lib/events-api.ts, filtri e campi
 * pubblici decisi dal database (public_local_events). Nessuna chiamata AI.
 */
import { NextResponse } from "next/server";
import { eventsReply } from "../../../../lib/events-api";
import { publicSupabase } from "../../../../lib/public-supabase";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const supabase = publicSupabase();
  const reply = await eventsReply(new URL(request.url).searchParams, supabase ? (args) => supabase.rpc("public_local_events", args) : null);
  return NextResponse.json(reply.body, { status: reply.status, headers: { "cache-control": reply.cacheControl } });
}
