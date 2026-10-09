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
  type AskAnswer,
  type AskRequest,
} from "./ask";

export const ASK_MODEL = "claude-opus-5-5";

/** Cartella dei bundle: la root del progetto Vercel può essere il monorepo o l'app. */
function bundlesDir(): string {
  const app = join(process.cwd(), "public", "bundles");
  return existsSync(app) ? app : join(process.cwd(), "apps", "guide", "public", "bundles");
}

interface Loaded {
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
  usage?: { input: number; cacheRead: number; output: number };
}

export async function askGuide(client: Anthropic, loaded: Loaded, req: AskRequest): Promise<AskOutcome> {
  const response = await client.beta.messages.create({
    model: ASK_MODEL,
    max_tokens: 4000,
    // Se il modello declina, l'API ripete la richiesta sul modello di ripiego consigliato.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // Risposte brevi da leggere a voce: poca riflessione, latenza bassa.
    output_config: { effort: "low", format: { type: "json_schema", schema: ANSWER_JSON_SCHEMA } },
    system: [
      { type: "text", text: SYSTEM_PROMPT },
      { type: "text", text: loaded.knowledge, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: buildQuestionMessage(loaded.content, req) }],
  });
  const usage = {
    input: response.usage.input_tokens,
    cacheRead: response.usage.cache_read_input_tokens ?? 0,
    output: response.usage.output_tokens,
  };

  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
    const reason = response.stop_reason === "refusal" ? "il modello ha rifiutato la richiesta" : "risposta troncata (limite di lunghezza)";
    return { answer: fallbackAnswer(req.locale, "rejected", reason), rejected: reason, usage };
  }
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const checked = checkModelAnswer(text, loaded.content, req);
  if (!checked.ok) return { answer: fallbackAnswer(req.locale, "rejected", checked.reason), rejected: checked.reason, usage };
  return { answer: checked.answer, usage };
}
