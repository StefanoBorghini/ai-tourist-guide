/**
 * Parte server delle domande alla guida: legge il bundle compilato e interroga il modello.
 *
 * La conoscenza arriva dallo stesso bundle che usa l'app (public/bundles, verificato con gli hash),
 * mai dal client: chi fa la domanda non può aggiungere "fatti" alla base.
 * La risposta locale passa da un ModelAdapter (model.ts): il fornitore si cambia con la configurazione.
 * La ricerca web usa lo strumento lato server di Anthropic. Ogni chiamata passa dal budget della
 * domanda (ask-cost.ts).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { verifyBundle, type BundleContent, type BundleManifest } from "@guide/bundle/client";
import { BUNDLES_BUCKET, bundleBase, combineIndexes, currentIndexObject, fetchPublishedIndex, findEntry, listIndexObjects, PUB_PREFIX, publishedOrigin, pubToStorageUrl, type BundleIndexEntry, type PublishedIndexResult } from "./bundle-index";
import { bundlesDir, readStaticIndex } from "./static-index";
import {
  ANSWER_JSON_SCHEMA,
  SYSTEM_PROMPT,
  buildKnowledge,
  askClock,
  buildQuestionMessage,
  checkModelAnswer,
  fallbackAnswer,
  sanitizeRequest,
  webNote,
  type AskAnswer,
  type AskMeter,
  type AskClock,
  type AskRequest,
} from "./ask";
import { WEB_SYSTEM_PROMPT, buildWebAddendum, needsWeb, parseWebAnswer, unsupportedNumbers, type ContentBlockLike, type ParsedWebAnswer, type WebConfig } from "./ask-web";
import { detectEmergency } from "./emergency";
import { DEFAULT_ANTHROPIC_MODEL, ModelError, type AskModels, type ModelAdapter } from "./model";
import { PERSONA, PERSONA_PROMPT } from "./persona";
import {
  addUsage,
  emptyUsage,
  estimateInputTokens,
  nextContextTokens,
  type BudgetSummary,
  type CallRecord,
  type CostQuality,
  type QuestionBudget,
  type Usage,
} from "./ask-cost";

/** Modello della risposta locale quando ASK_MODEL non è impostato (fornitore Anthropic). */
export const ASK_MODEL = DEFAULT_ANTHROPIC_MODEL;

/** Versioni di istruzioni e persona, per i log: dicono con quali regole è stata data una risposta. */
export const PROMPT_VERSION = createHash("sha256").update(`${SYSTEM_PROMPT}\n${WEB_SYSTEM_PROMPT}\n${PERSONA_PROMPT}`).digest("hex").slice(0, 12);
export const PERSONA_VERSION = `${PERSONA.id}@${PERSONA.version}`;

/**
 * Tempi: la route ha 60 s (maxDuration). La risposta locale ha un solo tentativo da 25 s; la ricerca
 * web usa il tempo che resta fino a ASK_DEADLINE_MS dall'inizio della domanda (lasciando 25 s alla
 * risposta locale di ripiego quando l'approfondimento va diretto alla ricerca) e non parte se ne
 * restano meno di WEB_MIN_MS. Così la funzione non viene interrotta dalla piattaforma senza risposta.
 */
export const LOCAL_TIMEOUT_MS = 25_000;
export const ASK_DEADLINE_MS = 55_000;
export const WEB_MIN_MS = 10_000;

/** Token massimi in uscita (ragionamento compreso) e minimi utili, per chiamata. */
export const LOCAL_MAX_TOKENS = 4000;
export const LOCAL_MIN_TOKENS = 1000;
export const WEB_MAX_TOKENS = 6000;
export const WEB_MIN_TOKENS = 1500;
/** Giri massimi della chiamata con ricerca (ripresa dopo `pause_turn`). */
export const WEB_MAX_ROUNDS = 3;

export interface Loaded {
  content: BundleContent;
  knowledge: string;
  /** Impronta della base di conoscenza del bundle: dice quale versione dei contenuti risponde. */
  kbHash: string;
}

export interface BundleVersion {
  destination: string;
  locale: string;
  kbHash: string;
}

/** Le destinazioni dello Studio non si leggono in questo momento: meglio dirlo che rispondere con altro. */
export class GuideUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuideUnavailableError";
  }
}

/**
 * Indice dei bundle pubblicati dallo Studio: dal bucket pubblico, ricontrollato ogni minuto.
 * Un errore si ricorda per pochi secondi, poi si riprova.
 */
const PUBLISHED_TTL_MS = 60_000;
const PUBLISHED_ERROR_TTL_MS = 10_000;
let published: { at: number; result: Promise<PublishedIndexResult> } | null = null;
let publishedOk = true;
function publishedIndex(): Promise<PublishedIndexResult> {
  const origin = publishedOrigin();
  if (!origin) return Promise.resolve({ ok: true, entries: [] });
  const ttl = publishedOk ? PUBLISHED_TTL_MS : PUBLISHED_ERROR_TTL_MS;
  if (!published || Date.now() - published.at > ttl) {
    // Lo stesso indice che serve /pub/index.json (proxy.ts): la fotografia numerata più alta.
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
    const result = currentIndexObject(listIndexObjects(origin, anonKey))
      .then((found): Promise<PublishedIndexResult> => found.ok
        ? fetchPublishedIndex((url) => fetch(url, { cache: "no-store" }), `${origin}/storage/v1/object/public/${BUNDLES_BUCKET}/${found.object}`)
        : Promise.resolve({ ok: false, error: found.error }))
      .then((r) => {
        publishedOk = r.ok;
        return r;
      });
    published = { at: Date.now(), result };
  }
  return published.result;
}

/** Testo di un file del bundle: dal disco (bundle dei file) o dal bucket (bundle pubblicati). */
async function readBundleFile(dir: string, url: string): Promise<string> {
  if (url.startsWith(PUB_PREFIX)) {
    const origin = publishedOrigin();
    if (!origin) throw new Error("bundle pubblicato ma Supabase non configurato");
    const r = await fetch(pubToStorageUrl(url, origin), { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} per ${url}`);
    return r.text();
  }
  return readFile(join(dir, url.replace(/^\/bundles\//, "")), "utf8");
}
const readManifest = async (dir: string, url: string) => JSON.parse(await readBundleFile(dir, url)) as BundleManifest;

/** Le stesse voci che vede l'app: bundle dei file, sostituiti da quelli pubblicati dallo Studio. */
async function currentIndex(dir: string): Promise<{ entries: BundleIndexEntry[]; publishedOk: boolean }> {
  return combineIndexes(await readStaticIndex(dir), await publishedIndex());
}

let versions: { at: number; value: Promise<BundleVersion[]> } | null = null;
/** Versioni dei bundle che il server usa per rispondere (per verificare che la pubblicazione sia aggiornata). */
export function bundleVersions(): Promise<BundleVersion[]> {
  if (!versions || (publishedOrigin() && Date.now() - versions.at > PUBLISHED_TTL_MS)) {
    const value = (async () => {
      const dir = bundlesDir();
      const { entries } = await currentIndex(dir);
      return Promise.all(entries.map(async (b) => ({ destination: b.destination, locale: b.locale, kbHash: (await readManifest(dir, b.manifest)).kbHash })));
    })();
    versions = { at: Date.now(), value };
    value.catch(() => (versions = null));
  }
  return versions.value;
}
const cache = new Map<string, { at: number; value: Promise<Loaded | null> }>();

/**
 * Contenuto verificato del bundle e testo della base di conoscenza, in memoria per istanza.
 * Per i bundle pubblicati dallo Studio si ricontrolla l'indice ogni minuto (una ripubblicazione cambia il manifest).
 */
export function loadKnowledge(destination: string, locale: string): Promise<Loaded | null> {
  const key = `${destination}/${locale}`;
  const hit = cache.get(key);
  if (hit && !(publishedOrigin() && Date.now() - hit.at > PUBLISHED_TTL_MS)) return hit.value;
  const value = (async () => {
    const dir = bundlesDir();
    const found = findEntry(await currentIndex(dir), destination, locale);
    // Destinazione dello Studio con l'indice pubblicato illeggibile: nessun ripiego sui file (non ce ne sono,
    // e i bundle dei file non hanno mai contenuti a pagamento), errore temporaneo esplicito.
    if ("unavailable" in found) throw new GuideUnavailableError(`${destination}: indice pubblicato non disponibile`);
    if ("unknown" in found) return null;
    const { entry } = found;
    const manifest = await readManifest(dir, entry.manifest);
    const json = await readBundleFile(dir, bundleBase(entry.manifest) + manifest.content);
    const content = await verifyBundle(manifest, json);
    return { content, knowledge: buildKnowledge(content), kbHash: manifest.kbHash };
  })();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

export interface AskOutcome {
  answer: AskAnswer;
  /** Motivo per cui la risposta del modello è stata scartata (per i log delle lacune). */
  rejected?: string;
  /** Consumi della risposta locale e di quella con ricerca, se ci sono state. */
  usage: { local?: Usage; web?: Usage };
  /** Dollari scalati dal budget (listino sui consumi reali; stime dove i consumi mancano). */
  costUsd: number;
  /** Quanto è affidabile costUsd. */
  costQuality: CostQuality;
  /** Budget della domanda: limite, speso, eventuale arresto. */
  budget: BudgetSummary;
  /** Ogni chiamata al modello, con piano, esito e costo (per i log, nessun segreto). */
  calls: CallRecord[];
  /** Diagnostica della ricerca web, per i log (nessun segreto). */
  web?: { attempted: boolean; error?: string; searches: number; rounds: number; sources: string[]; unknownRefs?: string[]; searchErrors?: string[] };
}

type LocalResult = { answer: AskAnswer; rejected?: string; usage: Usage | null; model: string };

/**
 * Un rifiuto HTTP 4xx (richiesta non eseguita) non consuma; tutto il resto può aver consumato.
 * Vale per gli errori dell'SDK di Anthropic e per quelli degli adattatori (ModelError).
 */
function failureInfo(error: unknown): { message: string; rejectedByApi: boolean } {
  if (error instanceof Anthropic.APIError || error instanceof ModelError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    const message = error instanceof ModelError ? error.message : `API ${status ?? "?"}: ${error.message}`;
    return { message, rejectedByApi: status !== undefined && status >= 400 && status < 500 };
  }
  return { message: (error as Error)?.message ?? String(error), rejectedByApi: false };
}

/** Piano della risposta locale (anche solo per sapere quanto tenere da parte per un ripiego). */
function planLocal(model: ModelAdapter, loaded: Loaded, req: AskRequest, budget: QuestionBudget, maxTokens = LOCAL_MAX_TOKENS, clock: AskClock = askClock()) {
  return budget.plan({
    model: model.model,
    inputTokens: estimateInputTokens(SYSTEM_PROMPT, PERSONA_PROMPT, loaded.knowledge, buildQuestionMessage(loaded.content, req, clock), JSON.stringify(ANSWER_JSON_SCHEMA)),
    maxTokens,
    minTokens: LOCAL_MIN_TOKENS,
  });
}

/**
 * Livello A: risposta dalla sola base verificata, con controllo rigoroso di citazioni e numeri.
 * Se il budget non basta nemmeno per la risposta minima, nessuna chiamata: risposta "non disponibile".
 */
export async function askLocal(model: ModelAdapter, loaded: Loaded, req: AskRequest, budget: QuestionBudget, clock: AskClock = askClock()): Promise<LocalResult> {
  const plan = planLocal(model, loaded, req, budget, LOCAL_MAX_TOKENS, clock);
  if (!plan.ok) {
    budget.stopped(`risposta locale non avviata: ${plan.reason}`);
    return { answer: fallbackAnswer(req.locale, "unavailable"), usage: null, model: model.model };
  }
  let response: Awaited<ReturnType<ModelAdapter["generate"]>>;
  try {
    response = await model.generate({
      // Istruzioni e persona fisse, poi la base: tutto il prefisso resta in cache tra una domanda e l'altra.
      system: [{ text: SYSTEM_PROMPT }, { text: PERSONA_PROMPT }, { text: loaded.knowledge, cache: true }],
      user: buildQuestionMessage(loaded.content, req, clock),
      jsonSchema: ANSWER_JSON_SCHEMA,
      maxTokens: plan.maxTokens,
      timeoutMs: LOCAL_TIMEOUT_MS,
    });
  } catch (error) {
    budget.recordFailure("local", plan, failureInfo(error));
    throw error;
  }
  // Il modello che ha risposto davvero (con il ripiego automatico può non essere quello richiesto).
  const usage = budget.recordSuccess("local", plan, response.usage, response.model).usage!;

  if (response.stop !== "end") {
    const reason = response.stop === "refusal" ? "il modello ha rifiutato la richiesta" : "risposta troncata (limite di lunghezza)";
    return { answer: fallbackAnswer(req.locale, "rejected", reason), rejected: reason, usage, model: response.model };
  }
  const checked = checkModelAnswer(response.text, loaded.content, req, clock);
  if (!checked.ok) {
    // Un'emergenza scartata dal controllo non diventa mai un «riprova»: si rimanda comunque al 112.
    const answer = fallbackAnswer(req.locale, checked.safety ? "safety" : "rejected", checked.reason);
    return { answer, rejected: checked.reason, usage, model: response.model };
  }
  return { answer: { ...checked.answer, origin: "local" }, usage, model: response.model };
}

type WebResult =
  | { ok: true; parsed: ParsedWebAnswer; blocks: ContentBlockLike[]; usage: Usage; model: string; rounds: number }
  | { ok: false; reason: string; usage: Usage; model: string; rounds: number };

/**
 * Livello B: il modello riceve la base, la risposta locale e lo strumento di ricerca web ufficiale.
 * Gestisce pause_turn (turni lunghi sospesi dal server) rimandando il messaggio così com'è, al massimo
 * WEB_MAX_ROUNDS giri. Prima di ogni giro il budget decide quante ricerche e quanti token concedere
 * (tenendo da parte `keepUsd` per un eventuale ripiego sulla base locale); se non basta, si ferma.
 * Gli errori dell'API non escono da qui: diventano un esito non riuscito, con i consumi già fatti.
 */
export async function askWeb(client: Anthropic, loaded: Loaded, req: AskRequest, local: AskAnswer | null, config: WebConfig, budget: QuestionBudget, keepUsd = 0, clock: AskClock = askClock()): Promise<WebResult> {
  const started = Date.now();
  let usage = emptyUsage();
  // Modello che ha risposto davvero (dalla risposta dell'API): serve a stimare il costo giusto.
  let model = config.model;
  const first = buildQuestionMessage(loaded.content, req, clock) + "\n" + buildWebAddendum(local, req);
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: "user", content: first }];
  const blocks: ContentBlockLike[] = [];
  let contextTokens = estimateInputTokens(WEB_SYSTEM_PROMPT, PERSONA_PROMPT, loaded.knowledge, first);
  for (let round = 1; round <= WEB_MAX_ROUNDS; round++) {
    const remainingMs = config.timeoutMs - (Date.now() - started);
    const remainingSearches = config.maxUses - usage.webSearches;
    if (remainingMs < 5_000 || remainingSearches < 1) return { ok: false, reason: "tempo o ricerche esauriti durante la pausa", usage, model, rounds: round - 1 };
    const plan = budget.plan({ model: config.model, inputTokens: contextTokens, maxTokens: WEB_MAX_TOKENS, minTokens: WEB_MIN_TOKENS, searches: remainingSearches, minSearches: 1, keepUsd });
    if (!plan.ok) {
      budget.stopped(`ricerca, giro ${round}, non avviata: ${plan.reason}`);
      return { ok: false, reason: "budget della domanda esaurito", usage, model, rounds: round - 1 };
    }
    const tool: Anthropic.Beta.Messages.BetaWebSearchTool20260318 = {
      type: "web_search_20260318",
      name: "web_search",
      max_uses: plan.searches,
      // Riduce i blocchi restituiti nella risposta; i risultati letti dal modello si pagano comunque.
      response_inclusion: "excluded",
      ...(config.blockedDomains.length > 0 ? { blocked_domains: config.blockedDomains } : {}),
    };
    let response: Anthropic.Beta.Messages.BetaMessage;
    try {
      response = await client.beta.messages.create(
        {
          model: config.model,
          max_tokens: plan.maxTokens,
          output_config: { effort: config.effort },
          tools: [tool],
          system: [
            { type: "text", text: WEB_SYSTEM_PROMPT },
            { type: "text", text: PERSONA_PROMPT },
            { type: "text", text: loaded.knowledge, cache_control: { type: "ephemeral" } },
          ],
          messages,
        },
        // Niente nuovi tentativi automatici: raddoppierebbero costi e attesa.
        { timeout: remainingMs, maxRetries: 0 },
      );
    } catch (error) {
      const info = failureInfo(error);
      budget.recordFailure("web", plan, info, round);
      return { ok: false, reason: info.message.slice(0, 300), usage, model, rounds: round };
    }
    model = response.model || model;
    usage = addUsage(usage, budget.recordSuccess("web", plan, response.usage, model, round).usage!);
    contextTokens = nextContextTokens(response.usage);
    blocks.push(...(response.content as ContentBlockLike[]));
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    if (response.stop_reason === "refusal") return { ok: false, reason: "il modello ha rifiutato la richiesta", usage, model, rounds: round };
    if (response.stop_reason === "max_tokens") return { ok: false, reason: "risposta troncata (limite di lunghezza)", usage, model, rounds: round };
    const parsed = parseWebAnswer(blocks, loaded.content, req);
    if (!parsed.text) return { ok: false, reason: "risposta vuota", usage, model, rounds: round };
    return { ok: true, parsed, blocks, usage, model, rounds: round };
  }
  return { ok: false, reason: "troppe pause del server", usage, model, rounds: WEB_MAX_ROUNDS };
}

/** Risposta locale con la dichiarazione del limite della ricerca online. */
function withWebNote(local: AskAnswer, locale: "it" | "en", kind: "webUnavailable" | "webNoSources"): AskAnswer {
  return { ...local, answer: `${local.answer} ${webNote(locale, kind)}`, ...(kind === "webUnavailable" ? { webUnavailable: true } : { webNoSources: true }) };
}

export interface WebGate {
  config: WebConfig;
  /** Il modello supporta la ricerca? (null = non verificato) */
  supported: boolean | null;
  /** Limiti di uso rispettati (per indirizzo e per giorno): se falso, niente ricerca. */
  permitted: () => boolean;
}

/**
 * Risposta ibrida: base locale prima (A); ricerca web solo se serve e se consentita (B);
 * risposta finale che combina le due (C). Se la ricerca non c'è o fallisce, la guida risponde
 * comunque con la base locale e lo dichiara.
 *
 * Approfondimento («Approfondisci»): la base locale ha già risposto alla stessa domanda, quindi si va
 * diretti alla ricerca (la base è comunque nel contesto) e la si interroga di nuovo solo se la
 * ricerca non è disponibile o non produce fonti. Così non si paga due volte la stessa risposta locale.
 *
 * Budget: ogni chiamata passa da `budget` (stima prima, costo reale dopo). Nell'approfondimento la
 * ricerca lascia da parte il costo della risposta locale minima, così il ripiego resta possibile.
 *
 * Prima di tutto: i campi del client si ripuliscono sul bundle, e un'emergenza riconosciuta dalle
 * parole chiave riceve il 112 senza nessuna chiamata. Senza client Anthropic la ricerca non c'è.
 */
export async function askGuide(ai: AskModels, loaded: Loaded, rawReq: AskRequest, webGate: WebGate | null, budget: QuestionBudget, clock: AskClock = askClock()): Promise<AskOutcome> {
  const started = Date.now();
  // Solo luoghi e affermazioni del bundle, risposte precedenti accorciate: il client non gonfia il prompt.
  const req = sanitizeRequest(loaded.content, rawReq);
  const client = ai.web;
  const gate = client ? webGate : null;
  let local: LocalResult | null = null;
  const getLocal = async () => (local ??= await askLocal(ai.local, loaded, req, budget, clock));
  const webOn = gate !== null && gate.config.enabled && gate.supported !== false;
  let permitted: boolean | undefined;
  const permit = () => (permitted ??= gate!.permitted());

  const done = (answer: AskAnswer, web?: AskOutcome["web"], webUsage?: Usage): AskOutcome => {
    const used = budget.calls.reduce((acc, c) => (c.usage ? addUsage(acc, c.usage) : acc), emptyUsage());
    const summary = budget.summary();
    const meter: AskMeter = {
      models: [...new Set(budget.calls.filter((c) => c.outcome === "ok").flatMap((c) => c.models))],
      calls: budget.calls.length,
      ...used,
      costUsd: summary.spentUsd,
      costQuality: summary.quality,
    };
    const l = local as LocalResult | null;
    return {
      answer: { ...answer, meter },
      ...(l?.rejected && answer.origin !== "web" ? { rejected: l.rejected } : {}),
      usage: { ...(l?.usage ? { local: l.usage } : {}), ...(webUsage ? { web: webUsage } : {}) },
      costUsd: summary.spentUsd,
      costQuality: summary.quality,
      budget: summary,
      calls: [...budget.calls],
      ...(web ? { web } : {}),
    };
  };
  /** Ripiego: la risposta locale (calcolata ora se serve) con la dichiarazione del limite. */
  const fallback = async (kind: "webUnavailable" | "webNoSources", web: AskOutcome["web"], webUsage?: Usage) => {
    const l = await getLocal();
    // Fuori tema, emergenza o senza servizio: la nota sulla ricerca non avrebbe senso.
    if (l.answer.status === "off_topic" || l.answer.status === "safety" || l.answer.status === "unavailable") return done(l.answer, web, webUsage);
    return done(withWebNote(l.answer, req.locale, kind), web, webUsage);
  };

  // Emergenza riconosciuta dalle parole chiave: 112 subito, nessuna chiamata, nessuna ricerca, anche con «Approfondisci».
  if (detectEmergency(req.question)) return done(fallbackAnswer(req.locale, "safety"));

  const direct = req.depth === "deep" && webOn && permit();
  let keepUsd = 0;
  if (direct) {
    // Il ripiego sulla base locale (risposta minima) deve restare pagabile anche se la ricerca usa tutto il resto.
    const reserve = planLocal(ai.local, loaded, req, budget, LOCAL_MIN_TOKENS, clock);
    keepUsd = reserve.ok ? reserve.worstUsd : 0;
  } else {
    const l = await getLocal();
    if (!gate || !gate.config.enabled || !needsWeb(l.answer, req, gate.config.auto)) return done(l.answer);
    if (gate.supported === false || !permit()) {
      return done(withWebNote(l.answer, req.locale, "webUnavailable"), { attempted: false, error: gate.supported === false ? "modello senza ricerca web" : "limite di uso raggiunto", searches: 0, rounds: 0, sources: [] });
    }
  }

  // Tempo per la ricerca: quello che resta, meno la risposta locale di ripiego se non c'è ancora.
  const webMs = Math.min(gate!.config.timeoutMs, started + ASK_DEADLINE_MS - Date.now() - (local ? 0 : LOCAL_TIMEOUT_MS));
  if (webMs < WEB_MIN_MS) return fallback("webUnavailable", { attempted: false, error: "tempo insufficiente per la ricerca", searches: 0, rounds: 0, sources: [] });

  let web: WebResult;
  try {
    web = await askWeb(client!, loaded, req, local ? (local as LocalResult).answer : null, { ...gate!.config, timeoutMs: webMs }, budget, keepUsd, clock);
  } catch (error) {
    return fallback("webUnavailable", { attempted: true, error: failureInfo(error).message.slice(0, 300), searches: 0, rounds: 0, sources: [] });
  }
  if (!web.ok) {
    const webUsed = budget.calls.some((c) => c.kind === "web" && c.usage !== null);
    return fallback("webUnavailable", { attempted: web.rounds > 0, error: web.reason, searches: web.usage.webSearches, rounds: web.rounds, sources: [] }, webUsed ? web.usage : undefined);
  }
  const { parsed } = web;
  const diag = {
    attempted: true,
    searches: web.usage.webSearches,
    rounds: web.rounds,
    sources: parsed.sources.map((s) => s.url),
    ...(parsed.unknownRefs.length > 0 ? { unknownRefs: parsed.unknownRefs } : {}),
    ...(parsed.searchErrors.length > 0 ? { searchErrors: parsed.searchErrors } : {}),
  };
  // Una risposta con ricerca che non cita né il web né la base non ha fatti controllabili: non si mostra.
  if (parsed.sources.length === 0 && parsed.packCitations.length === 0 && !parsed.usedPosition) {
    const allFailed = parsed.searchErrors.length > 0 && web.usage.webSearches === 0;
    return fallback(allFailed ? "webUnavailable" : "webNoSources", { ...diag, error: "risposta senza fonti citate" }, web.usage);
  }
  const byRef = new Map(loaded.content.assertions.map((a) => [a.ref, a]));
  const inReview = parsed.packCitations.some((ref) => byRef.get(ref)?.inReview === true);
  const unsupported = unsupportedNumbers(parsed, web.blocks, loaded.content, req, local ? (local as LocalResult).answer : null);
  return done(
    {
      status: parsed.sources.length > 0 ? "answered" : "partial",
      answer: parsed.text,
      citations: parsed.packCitations,
      origin: "web",
      webSources: parsed.sources,
      webSearches: web.usage.webSearches,
      ...(inReview ? { inReview } : {}),
      ...(parsed.usedPosition ? { usedPosition: true } : {}),
      ...(unsupported.length > 0 ? { unsupportedNumbers: unsupported } : {}),
    },
    diag,
    web.usage,
  );
}

let capability: { at: number; value: Promise<boolean | null> } | null = null;
/**
 * Il modello supporta la ricerca web? Lo dice la Models API (capabilities.server_tools.web_search).
 * Risultato in memoria per un'ora; null se non si riesce a saperlo (si prova comunque, e un errore
 * della chiamata fa rispondere con la sola base locale).
 */
export function webSearchSupported(client: Anthropic, model: string): Promise<boolean | null> {
  if (capability && Date.now() - capability.at < 3_600_000) return capability.value;
  const value = client.models
    .retrieve(model, {}, { timeout: 5_000, maxRetries: 0 })
    .then((info) => {
      const caps = (info as unknown as { capabilities?: { server_tools?: { web_search?: { supported?: unknown } } } | null }).capabilities;
      const supported = caps?.server_tools?.web_search?.supported;
      return typeof supported === "boolean" ? supported : null;
    })
    .catch(() => null);
  capability = { at: Date.now(), value };
  return value;
}
