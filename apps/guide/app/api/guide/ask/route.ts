/**
 * POST /api/guide/ask — risposta ibrida alle domande dei visitatori.
 *
 * A. base di conoscenza verificata del bundle (sempre, per prima);
 * B. ricerca web ufficiale dell'API Anthropic, solo se la base non basta o se il visitatore chiede
 *    di approfondire, entro i limiti configurati (vedi lib/ask-web.ts → webConfig);
 * C. risposta finale con le fonti.
 *
 * Prima di tutto le emergenze (lib/emergency.ts): rimando al 112 immediato, senza modello, senza
 * limiti e senza configurazione. Poi limiti per indirizzo e tetto di spesa giornaliero (lib/limits.ts).
 *
 * Il modello della risposta locale si sceglie con le variabili d'ambiente (lib/model.ts → modelsConfig):
 * per default Anthropic con ANTHROPIC_API_KEY. Senza configurazione valida risponde 503 e l'app
 * continua a funzionare (solo racconto, niente domande).
 */
import Anthropic from "@anthropic-ai/sdk";
import { askRequestSchema, fallbackAnswer, type AskAnswer } from "../../../../lib/ask";
import { PERSONA_VERSION, PROMPT_VERSION, askGuide, bundleVersions, GuideUnavailableError, loadKnowledge, webSearchSupported } from "../../../../lib/ask-server";
import { DailyCounter, TtlCache, cacheKey, cacheable, redactForLog, reserveUsd, webConfig } from "../../../../lib/ask-web";
import { detectEmergency } from "../../../../lib/emergency";
import { SpendGuard, WindowLimiter, dailyBudgetUsd } from "../../../../lib/limits";
import { ModelError, modelsConfig, modelsFromEnv, type AskModels } from "../../../../lib/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// La risposta con ricerca può richiedere fino a ~50 secondi (tempi in lib/ask-server.ts).
export const maxDuration = 60;

// Limiti per indirizzo, per istanza: un argine contro gli abusi, non una quota precisa.
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 20;

const config = webConfig();
const askLimiter = new WindowLimiter(MAX_PER_WINDOW, WINDOW_MS);
const webLimiter = new WindowLimiter(config.perIp, WINDOW_MS);
const webDaily = new DailyCounter(config.dailyLimit);
const spend = new SpendGuard(dailyBudgetUsd());
const answers = new TtlCache<AskAnswer>(config.cacheTtlHours * 3_600_000);

let models: AskModels | null | undefined;
const getModels = () => (models === undefined ? (models = modelsFromEnv()) : models);

/**
 * Le domande sono disponibili? (L'app lo chiede per decidere se invitare a farle.)
 * Riporta anche le impronte dei bundle con cui il server risponde e lo stato della ricerca web.
 * Nessun segreto: solo presenza della configurazione, fornitore, versioni e parametri pubblici.
 */
export async function GET(): Promise<Response> {
  const setup = modelsConfig();
  const web = setup.ok ? (getModels()?.web ?? null) : null;
  const [bundles, supported] = await Promise.all([
    bundleVersions().catch(() => []),
    web && config.enabled ? webSearchSupported(web, config.model) : Promise.resolve(null),
  ]);
  return Response.json(
    {
      available: setup.ok,
      ...(setup.ok ? { provider: setup.provider, model: setup.model } : {}),
      prompt: PROMPT_VERSION,
      persona: PERSONA_VERSION,
      bundles,
      web: { enabled: web !== null && config.enabled, model: config.model, tool: "web_search_20260318", maxUses: config.maxUses, supported },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const started = Date.now();
  const parsed = askRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "richiesta non valida" }, { status: 400 });
  const req = parsed.data;

  // Emergenza: subito il 112, prima di configurazione, limiti, contenuti e modello. Nessun costo.
  if (detectEmergency(req.question)) {
    console.info(JSON.stringify({ event: "emergency", source: "keywords", locale: req.locale, ms: Date.now() - started }));
    return Response.json(fallbackAnswer(req.locale, "safety"), { headers: { "cache-control": "no-store" } });
  }

  const ai = getModels();
  if (!ai) return Response.json(fallbackAnswer(req.locale, "unavailable"), { status: 503 });
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  if (askLimiter.hit(ip)) return Response.json(fallbackAnswer(req.locale, "unavailable"), { status: 429 });

  let unavailable = false;
  const loaded = await loadKnowledge(req.destination, req.locale).catch((e) => {
    unavailable = e instanceof GuideUnavailableError;
    return null;
  });
  // Contenuti dello Studio non raggiungibili: si dice, senza ripiegare su altri contenuti.
  if (!loaded && unavailable) return Response.json(fallbackAnswer(req.locale, "unavailable"), { status: 503, headers: { "retry-after": "30" } });
  if (!loaded) return Response.json({ error: "destinazione sconosciuta" }, { status: 404 });

  // Cache: stessa domanda, stesso luogo, stessa versione dei contenuti, senza conversazione alle spalle.
  const key = cacheKey(req, loaded.kbHash);
  const hit = key ? answers.get(key) : undefined;
  if (hit) {
    console.info(JSON.stringify({ event: "ask", status: hit.status, origin: hit.origin ?? "local", cached: true, kbHash: loaded.kbHash, prompt: PROMPT_VERSION, ms: Date.now() - started }));
    // Dalla cache: nessuna chiamata al modello, costo zero.
    const meter = { models: [], calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, webSearches: 0, costUsd: 0 };
    return Response.json({ ...hit, cached: true, meter });
  }

  // Tetto di spesa: la riserva prudente della risposta locale deve starci; la ricerca chiede la sua.
  const localReserve = reserveUsd(ai.local.model, null);
  const webReserve = Math.max(0, reserveUsd(ai.local.model, config) - localReserve);
  if (!spend.allows(localReserve)) {
    console.warn(JSON.stringify({ event: "budget_exceeded", dailyUsd: spend.dailyUsd, spentUsd: spend.spentToday() }));
    return Response.json(fallbackAnswer(req.locale, "unavailable"), { status: 503, headers: { "retry-after": "3600" } });
  }

  try {
    const supported = ai.web && config.enabled ? await webSearchSupported(ai.web, config.model) : null;
    const outcome = await askGuide(ai, loaded, req, {
      config,
      supported,
      permitted: () => {
        if (!webDaily.available() || !webLimiter.allows(ip) || !spend.allows(localReserve + webReserve)) return false;
        webDaily.take();
        webLimiter.hit(ip);
        return true;
      },
    });
    // Costo stimato; se non si può stimare (modello senza listino) si conta la riserva prudente.
    const calls = outcome.answer.meter?.calls ?? 0;
    spend.record(outcome.costUsd ?? (calls === 0 ? 0 : localReserve + (outcome.usage.web ? webReserve : 0)));
    // Lacune della base di conoscenza: domande senza risposta verificata, utili alla redazione.
    if (outcome.answer.status === "not_in_knowledge" || outcome.rejected || outcome.answer.origin === "web") {
      console.info(JSON.stringify({
        event: outcome.answer.origin === "web" ? "web_answer" : "knowledge_gap",
        destination: req.destination,
        locale: req.locale,
        place: req.currentPlace ?? null,
        selected: req.selectedPlace ?? null,
        kbHash: loaded.kbHash,
        // Email e numeri di telefono mascherati: alla redazione serve la domanda, non i contatti.
        question: redactForLog(req.question),
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
      provider: ai.local.provider,
      prompt: PROMPT_VERSION,
      persona: PERSONA_VERSION,
      // Modelli che hanno risposto davvero (dalla risposta dell'API; ai.local.model è quello richiesto).
      models: outcome.answer.meter?.models ?? [ai.local.model],
      calls,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      spentTodayUsd: spend.spentToday(),
      otherPlaceCitations: outcome.answer.otherPlaceCitations ?? [],
      web: outcome.web ? { attempted: outcome.web.attempted, searches: outcome.web.searches, sources: outcome.web.sources.length, error: outcome.web.error, searchErrors: outcome.web.searchErrors } : null,
      ms: Date.now() - started,
    }));
    if (key && cacheable(outcome.answer)) answers.set(key, { ...outcome.answer, meter: undefined });
    return Response.json(outcome.answer);
  } catch (error) {
    // La chiamata può essere costata anche se è fallita: si conta la riserva della risposta locale.
    spend.record(localReserve);
    if ((error instanceof ModelError && error.kind === "rate_limit") || error instanceof Anthropic.RateLimitError) {
      return Response.json(fallbackAnswer(req.locale, "unavailable"), { status: 429 });
    }
    if (error instanceof ModelError || error instanceof Anthropic.APIError) {
      console.error(JSON.stringify({ event: "ask_error", provider: ai.local.provider, status: error.status, message: error.message }));
    } else {
      console.error(JSON.stringify({ event: "ask_error", provider: ai.local.provider, message: (error as Error).message }));
    }
    return Response.json(fallbackAnswer(req.locale, "unavailable"), { status: 502 });
  }
}
