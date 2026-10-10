/**
 * POST /api/guide/ask — risposta ibrida alle domande dei visitatori.
 *
 * A. base di conoscenza verificata del bundle (sempre, per prima);
 * B. ricerca web ufficiale dell'API Anthropic, solo se la base non basta o se il visitatore chiede
 *    di approfondire, entro i limiti configurati (vedi lib/ask-web.ts → webConfig);
 * C. risposta finale con le fonti.
 *
 * Richiede ANTHROPIC_API_KEY nelle variabili d'ambiente del progetto; senza, risponde 503
 * e l'app continua a funzionare (solo racconto, niente domande).
 */
import Anthropic from "@anthropic-ai/sdk";
import { askRequestSchema, fallbackAnswer, type AskAnswer } from "../../../../lib/ask";
import { ASK_MODEL, askGuide, bundleVersions, loadKnowledge, webSearchSupported } from "../../../../lib/ask-server";
import { DailyCounter, TtlCache, cacheKey, cacheable, webConfig } from "../../../../lib/ask-web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// La risposta con ricerca può richiedere fino a ~50 secondi.
export const maxDuration = 60;

// Limiti per indirizzo, per istanza: un argine contro gli abusi, non una quota precisa.
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 20;

class WindowLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max: number) {}
  /** Registra un uso e dice se il limite è superato. */
  hit(key: string, now = Date.now()): boolean {
    const recent = this.peek(key, now);
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.hits.clear();
    return recent.length > this.max;
  }
  /** C'è ancora spazio, senza registrare l'uso? */
  allows(key: string, now = Date.now()): boolean {
    return this.peek(key, now).length < this.max;
  }
  private peek(key: string, now: number): number[] {
    return (this.hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  }
}

const config = webConfig();
const askLimiter = new WindowLimiter(MAX_PER_WINDOW);
const webLimiter = new WindowLimiter(config.perIp);
const webDaily = new DailyCounter(config.dailyLimit);
const answers = new TtlCache<AskAnswer>(config.cacheTtlHours * 3_600_000);

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

/**
 * Le domande sono disponibili? (L'app lo chiede per decidere se invitare a farle.)
 * Riporta anche le impronte dei bundle con cui il server risponde e lo stato della ricerca web.
 * Nessun segreto: solo presenza della chiave, impronte e parametri pubblici.
 */
export async function GET(): Promise<Response> {
  const available = Boolean(process.env.ANTHROPIC_API_KEY);
  const [bundles, supported] = await Promise.all([
    bundleVersions().catch(() => []),
    available && config.enabled ? webSearchSupported(getClient(), config.model) : Promise.resolve(null),
  ]);
  return Response.json(
    {
      available,
      bundles,
      web: { enabled: available && config.enabled, model: config.model, tool: "web_search_20260318", maxUses: config.maxUses, supported },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const started = Date.now();
  const parsed = askRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "richiesta non valida" }, { status: 400 });
  const req = parsed.data;

  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(fallbackAnswer(req.locale, "unavailable"), { status: 503 });
  }
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  if (askLimiter.hit(ip)) return Response.json(fallbackAnswer(req.locale, "unavailable"), { status: 429 });

  const loaded = await loadKnowledge(req.destination, req.locale).catch(() => null);
  if (!loaded) return Response.json({ error: "destinazione sconosciuta" }, { status: 404 });

  // Cache: stessa domanda, stesso luogo, stessa versione dei contenuti, senza conversazione alle spalle.
  const key = cacheKey(req, loaded.kbHash);
  const hit = key ? answers.get(key) : undefined;
  if (hit) {
    console.info(JSON.stringify({ event: "ask", status: hit.status, origin: hit.origin ?? "local", cached: true, kbHash: loaded.kbHash, ms: Date.now() - started }));
    // Dalla cache: nessuna chiamata al modello, costo zero.
    const meter = { models: [], calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, webSearches: 0, costUsd: 0 };
    return Response.json({ ...hit, cached: true, meter });
  }

  const ai = getClient();
  try {
    const supported = config.enabled ? await webSearchSupported(ai, config.model) : null;
    const outcome = await askGuide(ai, loaded, req, {
      config,
      supported,
      permitted: () => {
        if (!webDaily.available() || !webLimiter.allows(ip)) return false;
        webDaily.take();
        webLimiter.hit(ip);
        return true;
      },
    });
    // Lacune della base di conoscenza: domande senza risposta verificata, utili alla redazione.
    if (outcome.answer.status === "not_in_knowledge" || outcome.rejected || outcome.answer.origin === "web") {
      console.info(JSON.stringify({
        event: outcome.answer.origin === "web" ? "web_answer" : "knowledge_gap",
        destination: req.destination,
        locale: req.locale,
        place: req.currentPlace ?? null,
        selected: req.selectedPlace ?? null,
        kbHash: loaded.kbHash,
        question: req.question,
        rejected: outcome.rejected ?? null,
        // Fonti web da valutare: entrano nel Territory Pack solo dopo la revisione della redazione.
        webSources: outcome.web?.sources ?? [],
        unsupportedNumbers: outcome.answer.unsupportedNumbers ?? [],
      }));
    }
    console.info(JSON.stringify({
      event: "ask",
      status: outcome.answer.status,
      origin: outcome.answer.origin ?? "local",
      depth: req.depth,
      cached: false,
      kbHash: loaded.kbHash,
      // Modelli che hanno risposto davvero (dalla risposta dell'API; ASK_MODEL è quello richiesto).
      models: outcome.answer.meter?.models ?? [ASK_MODEL],
      calls: outcome.answer.meter?.calls ?? 0,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      web: outcome.web ? { attempted: outcome.web.attempted, searches: outcome.web.searches, sources: outcome.web.sources.length, error: outcome.web.error, searchErrors: outcome.web.searchErrors } : null,
      ms: Date.now() - started,
    }));
    if (key && cacheable(outcome.answer)) answers.set(key, { ...outcome.answer, meter: undefined });
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
