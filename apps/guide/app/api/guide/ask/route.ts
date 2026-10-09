/**
 * POST /api/guide/ask — risponde a una domanda usando solo le affermazioni verificate del bundle.
 *
 * Richiede ANTHROPIC_API_KEY nelle variabili d'ambiente del progetto; senza, risponde 503
 * e l'app continua a funzionare (solo racconto, niente domande).
 */
import Anthropic from "@anthropic-ai/sdk";
import { askRequestSchema, fallbackAnswer } from "../../../../lib/ask";
import { askGuide, bundleVersions, loadKnowledge } from "../../../../lib/ask-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Limite per indirizzo, per istanza: un argine contro gli abusi, non una quota precisa.
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, number[]>();

function rateLimited(key: string, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > MAX_PER_WINDOW;
}

let client: Anthropic | null = null;

/**
 * Le domande sono disponibili? (L'app lo chiede per decidere se invitare a farle.)
 * Riporta anche le impronte dei bundle con cui il server risponde, per verificare che la versione
 * pubblicata usi i contenuti aggiornati. Nessun segreto: solo presenza della chiave e impronte.
 */
export async function GET(): Promise<Response> {
  const bundles = await bundleVersions().catch(() => []);
  return Response.json({ available: Boolean(process.env.ANTHROPIC_API_KEY), bundles }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const parsed = askRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "richiesta non valida" }, { status: 400 });
  const req = parsed.data;

  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(fallbackAnswer(req.locale, "unavailable"), { status: 503 });
  }
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  if (rateLimited(ip)) return Response.json(fallbackAnswer(req.locale, "unavailable"), { status: 429 });

  const loaded = await loadKnowledge(req.destination, req.locale).catch(() => null);
  if (!loaded) return Response.json({ error: "destinazione sconosciuta" }, { status: 404 });

  client ??= new Anthropic();
  try {
    const outcome = await askGuide(client, loaded, req);
    // Lacune della base di conoscenza: domande senza risposta verificata, utili alla redazione.
    if (outcome.answer.status === "not_in_knowledge" || outcome.rejected) {
      console.info(JSON.stringify({
        event: "knowledge_gap",
        destination: req.destination,
        locale: req.locale,
        place: req.currentPlace ?? null,
        selected: req.selectedPlace ?? null,
        kbHash: loaded.kbHash,
        question: req.question,
        rejected: outcome.rejected ?? null,
      }));
    }
    console.info(JSON.stringify({ event: "ask", status: outcome.answer.status, kbHash: loaded.kbHash, usage: outcome.usage }));
    return Response.json(outcome.answer);
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return Response.json(fallbackAnswer(req.locale, "unavailable"), { status: 429 });
    }
    if (error instanceof Anthropic.APIError) {
      console.error(JSON.stringify({ event: "ask_error", status: error.status, message: error.message }));
    } else {
      console.error(JSON.stringify({ event: "ask_error", message: (error as Error).message }));
    }
    return Response.json(fallbackAnswer(req.locale, "unavailable"), { status: 502 });
  }
}
