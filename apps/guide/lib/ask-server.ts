/**
 * Parte server delle domande alla guida: legge il bundle compilato e interroga Claude.
 *
 * La conoscenza arriva dallo stesso bundle che usa l'app (public/bundles, verificato con gli hash),
 * mai dal client: chi fa la domanda non può aggiungere "fatti" alla base.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { verifyBundle, type BundleContent, type BundleManifest } from "@guide/bundle/client";
import {
  ANSWER_JSON_SCHEMA,
  SYSTEM_PROMPT,
  buildKnowledge,
  buildQuestionMessage,
  checkModelAnswer,
  fallbackAnswer,
  webNote,
  type AskAnswer,
  type AskMeter,
  type AskRequest,
} from "./ask";
import {
  WEB_SYSTEM_PROMPT,
  addUsage,
  buildWebAddendum,
  emptyUsage,
  estimateUsd,
  needsWeb,
  parseWebAnswer,
  unsupportedNumbers,
  type ContentBlockLike,
  type ParsedWebAnswer,
  type Usage,
  type WebConfig,
} from "./ask-web";

export const ASK_MODEL = "claude-opus-5-5";

/** Cartella dei bundle: la root del progetto Vercel può essere il monorepo o l'app. */
function bundlesDir(): string {
  const app = join(process.cwd(), "public", "bundles");
  return existsSync(app) ? app : join(process.cwd(), "apps", "guide", "public", "bundles");
}

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

interface BundleIndex {
  bundles: { destination: string; locale: string; manifest: string }[];
}
const readIndex = async (dir: string) => JSON.parse(await readFile(join(dir, "index.json"), "utf8")) as BundleIndex;
const readManifest = async (dir: string, url: string) =>
  JSON.parse(await readFile(join(dir, url.replace(/^\/bundles\//, "")), "utf8")) as BundleManifest;

let versions: Promise<BundleVersion[]> | null = null;
/** Versioni dei bundle che il server usa per rispondere (per verificare che la pubblicazione sia aggiornata). */
export function bundleVersions(): Promise<BundleVersion[]> {
  versions ??= (async () => {
    const dir = bundlesDir();
    const index = await readIndex(dir);
    return Promise.all(
      index.bundles.map(async (b) => ({ destination: b.destination, locale: b.locale, kbHash: (await readManifest(dir, b.manifest)).kbHash })),
    );
  })().catch((e: unknown) => {
    versions = null;
    throw e;
  });
  return versions;
}
const cache = new Map<string, Promise<Loaded | null>>();

/** Contenuto verificato del bundle e testo della base di conoscenza, in memoria per istanza. */
export function loadKnowledge(destination: string, locale: string): Promise<Loaded | null> {
  const key = `${destination}/${locale}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = (async () => {
      const dir = bundlesDir();
      const index = await readIndex(dir);
      const entry = index.bundles.find((b) => b.destination === destination && b.locale === locale);
      if (!entry) return null;
      const rel = entry.manifest.replace(/^\/bundles\//, "");
      const manifest = await readManifest(dir, entry.manifest);
      const json = await readFile(join(dir, rel.replace(/manifest\.json$/, ""), manifest.content), "utf8");
      const content = await verifyBundle(manifest, json);
      return { content, knowledge: buildKnowledge(content), kbHash: manifest.kbHash };
    })().catch((e: unknown) => {
      cache.delete(key);
      throw e;
    });
    cache.set(key, hit);
  }
  return hit;
}

export interface AskOutcome {
  answer: AskAnswer;
  /** Motivo per cui la risposta del modello è stata scartata (per i log delle lacune). */
  rejected?: string;
  /** Consumi della risposta locale e di quella con ricerca, se ci sono state. */
  usage: { local?: Usage; web?: Usage };
  /** Stima in dollari (listino pubblico). */
  costUsd: number | null;
  /** Diagnostica della ricerca web, per i log (nessun segreto). */
  web?: { attempted: boolean; error?: string; searches: number; sources: string[]; unknownRefs?: string[]; searchErrors?: string[] };
}

type LocalResult = { answer: AskAnswer; rejected?: string; usage: Usage; model: string };

const toUsage = (u: Anthropic.Beta.Messages.BetaUsage): Usage => ({
  input: u.input_tokens,
  cacheWrite: u.cache_creation_input_tokens ?? 0,
  cacheRead: u.cache_read_input_tokens ?? 0,
  output: u.output_tokens,
  webSearches: u.server_tool_use?.web_search_requests ?? 0,
});

/** Livello A: risposta dalla sola base verificata, con controllo rigoroso di citazioni e numeri. */
export async function askLocal(client: Anthropic, loaded: Loaded, req: AskRequest): Promise<LocalResult> {
  const response = await client.beta.messages.create(
    {
      model: ASK_MODEL,
      max_tokens: 4000,
      // Se il modello declina, l'API ripete la richiesta sul modello di ripiego consigliato.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // Risposte da leggere a voce: poca riflessione, latenza bassa.
      output_config: { effort: "low", format: { type: "json_schema", schema: ANSWER_JSON_SCHEMA } },
      system: [
        { type: "text", text: SYSTEM_PROMPT },
        { type: "text", text: loaded.knowledge, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: buildQuestionMessage(loaded.content, req) }],
    },
    { timeout: 25_000 },
  );
  const usage = toUsage(response.usage);
  // Il modello che ha risposto davvero (con il ripiego automatico può non essere ASK_MODEL).
  const model = response.model || ASK_MODEL;

  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
    const reason = response.stop_reason === "refusal" ? "il modello ha rifiutato la richiesta" : "risposta troncata (limite di lunghezza)";
    return { answer: fallbackAnswer(req.locale, "rejected", reason), rejected: reason, usage, model };
  }
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const checked = checkModelAnswer(text, loaded.content, req);
  if (!checked.ok) return { answer: fallbackAnswer(req.locale, "rejected", checked.reason), rejected: checked.reason, usage, model };
  return { answer: { ...checked.answer, origin: "local" }, usage, model };
}

type WebResult =
  | { ok: true; parsed: ParsedWebAnswer; blocks: ContentBlockLike[]; usage: Usage }
  | { ok: false; reason: string; usage: Usage };

/**
 * Livello B: il modello riceve la base, la risposta locale e lo strumento di ricerca web ufficiale.
 * Gestisce pause_turn (turni lunghi sospesi dal server) rimandando il messaggio così com'è.
 */
export async function askWeb(client: Anthropic, loaded: Loaded, req: AskRequest, local: AskAnswer | null, config: WebConfig): Promise<WebResult> {
  const started = Date.now();
  let usage = emptyUsage();
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
    { role: "user", content: buildQuestionMessage(loaded.content, req) + "\n" + buildWebAddendum(local, req) },
  ];
  const blocks: ContentBlockLike[] = [];
  for (let round = 0; round < 3; round++) {
    const remainingMs = config.timeoutMs - (Date.now() - started);
    const remainingSearches = config.maxUses - usage.webSearches;
    if (remainingMs < 5_000 || remainingSearches < 1) return { ok: false, reason: "tempo o ricerche esauriti durante la pausa", usage };
    const tool: Anthropic.Beta.Messages.BetaWebSearchTool20260318 = {
      type: "web_search_20260318",
      name: "web_search",
      max_uses: remainingSearches,
      // I risultati già filtrati dal codice non tornano nella risposta: meno token in uscita.
      response_inclusion: "excluded",
      ...(config.blockedDomains.length > 0 ? { blocked_domains: config.blockedDomains } : {}),
    };
    const response = await client.beta.messages.create(
      {
        model: config.model,
        max_tokens: 6000,
        output_config: { effort: config.effort },
        tools: [tool],
        system: [
          { type: "text", text: WEB_SYSTEM_PROMPT },
          { type: "text", text: loaded.knowledge, cache_control: { type: "ephemeral" } },
        ],
        messages,
      },
      // Niente nuovi tentativi automatici: raddoppierebbero costi e attesa.
      { timeout: remainingMs, maxRetries: 0 },
    );
    usage = addUsage(usage, toUsage(response.usage));
    blocks.push(...(response.content as ContentBlockLike[]));
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    if (response.stop_reason === "refusal") return { ok: false, reason: "il modello ha rifiutato la richiesta", usage };
    if (response.stop_reason === "max_tokens") return { ok: false, reason: "risposta troncata (limite di lunghezza)", usage };
    const parsed = parseWebAnswer(blocks, loaded.content, req);
    if (!parsed.text) return { ok: false, reason: "risposta vuota", usage };
    return { ok: true, parsed, blocks, usage };
  }
  return { ok: false, reason: "troppe pause del server", usage };
}

/** Risposta locale con la dichiarazione del limite della ricerca online. */
function withWebNote(local: AskAnswer, locale: "it" | "en", kind: "webUnavailable" | "webNoSources"): AskAnswer {
  return { ...local, answer: `${local.answer} ${webNote(locale, kind)}`, ...(kind === "webUnavailable" ? { webUnavailable: true } : {}) };
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
 */
export async function askGuide(client: Anthropic, loaded: Loaded, req: AskRequest, gate: WebGate | null = null): Promise<AskOutcome> {
  let local: LocalResult | null = null;
  const getLocal = async () => (local ??= await askLocal(client, loaded, req));
  const webOn = gate !== null && gate.config.enabled && gate.supported !== false;
  let permitted: boolean | undefined;
  const permit = () => (permitted ??= gate!.permitted());

  const done = (answer: AskAnswer, web?: AskOutcome["web"], webUsage?: Usage): AskOutcome => {
    const parts: [string, Usage][] = [];
    if (local) parts.push([local.model, local.usage]);
    if (webUsage) parts.push([gate!.config.model, webUsage]);
    const total = parts.reduce((acc, [, u]) => addUsage(acc, u), emptyUsage());
    const costs = parts.map(([m, u]) => estimateUsd(m, u));
    const costUsd = costs.some((c) => c === null) ? null : Math.round(costs.reduce((a, c) => a! + c!, 0)! * 1e5) / 1e5;
    const meter: AskMeter = { models: [...new Set(parts.map(([m]) => m))], calls: parts.length, ...total, costUsd };
    return {
      answer: { ...answer, meter },
      ...(local?.rejected && answer.origin !== "web" ? { rejected: local.rejected } : {}),
      usage: { ...(local ? { local: local.usage } : {}), ...(webUsage ? { web: webUsage } : {}) },
      costUsd,
      ...(web ? { web } : {}),
    };
  };
  /** Ripiego: la risposta locale (calcolata ora se serve) con la dichiarazione del limite. */
  const fallback = async (kind: "webUnavailable" | "webNoSources", web: AskOutcome["web"], webUsage?: Usage) => {
    const l = await getLocal();
    // Fuori tema o senza servizio: la nota sulla ricerca non avrebbe senso.
    if (l.answer.status === "off_topic" || l.answer.status === "unavailable") return done(l.answer, web, webUsage);
    return done(withWebNote(l.answer, req.locale, kind), web, webUsage);
  };

  const direct = req.depth === "deep" && webOn && permit();
  if (!direct) {
    const l = await getLocal();
    if (!gate || !gate.config.enabled || !needsWeb(l.answer, req)) return done(l.answer);
    if (gate.supported === false || !permit()) {
      return done(withWebNote(l.answer, req.locale, "webUnavailable"), { attempted: false, error: gate.supported === false ? "modello senza ricerca web" : "limite di uso raggiunto", searches: 0, sources: [] });
    }
  }

  let web: WebResult;
  try {
    web = await askWeb(client, loaded, req, local ? (local as LocalResult).answer : null, gate!.config);
  } catch (error) {
    const message = error instanceof Anthropic.APIError ? `API ${error.status ?? "?"}: ${error.message}` : (error as Error).message;
    return fallback("webUnavailable", { attempted: true, error: message.slice(0, 300), searches: 0, sources: [] });
  }
  if (!web.ok) {
    return fallback("webUnavailable", { attempted: true, error: web.reason, searches: web.usage.webSearches, sources: [] }, web.usage);
  }
  const { parsed } = web;
  const diag = {
    attempted: true,
    searches: web.usage.webSearches,
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
