"use client";

import { useEffect, useRef, useState } from "react";
import type { BundleContent } from "@guide/bundle/client";
import { distanceM } from "@guide/context-engine";
import { rememberAssertions } from "@guide/narrative-planner";
import { ASK_LIMITS, fallbackAnswer, type AskAnswer, type WebSource } from "../lib/ask";
import type { PositionSource } from "../lib/field-points";
import type { GuideRuntime } from "../lib/runtime";
import type { GuideVoice } from "../lib/speech";
import type { UiText } from "../lib/i18n";

const NEARBY_M = 300;

/** Riconoscimento vocale del browser (non standard: Chrome e Safari lo espongono con prefisso). */
interface Recognition {
  lang: string;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}
function recognitionCtor(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => Recognition) | null;
}

export function AskBox(props: {
  content: BundleContent;
  runtime: GuideRuntime;
  voice: GuideVoice | null;
  online: boolean;
  t: UiText;
  /** Luogo selezionato sulla mappa o nell'elenco: la domanda lo riguarda, anche se si è altrove. */
  selectedPlace?: string | null;
  fixSource?: PositionSource | null;
  /** Cambia quando si preme «Fai una domanda»: il campo prende il fuoco. */
  focusKey?: number;
  /** In modalità debug si mostra quale controllo ha scartato una risposta. */
  debug?: boolean;
  /** Il server può approfondire con la ricerca web. */
  webAvailable?: boolean;
}) {
  const { content, runtime, voice, online, t, selectedPlace, fixSource, focusKey, debug, webAvailable } = props;
  const locale = content.locale === "it" ? "it" : "en";
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [listening, setListening] = useState(false);
  const [answers, setAnswers] = useState<{ question: string; answer: AskAnswer }[]>([]);
  const recognitionRef = useRef<Recognition | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const Recognition = recognitionCtor();
  const about = selectedPlace ?? runtime.currentPlaceRef;

  useEffect(() => {
    if (!focusKey) return;
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    inputRef.current?.focus({ preventScroll: true });
  }, [focusKey]);

  const ask = async (text: string, depth: "auto" | "deep" = "auto") => {
    const q = text.trim();
    if (q.length < 2 || busy) return;
    setBusy(true);
    // Dopo qualche secondo si spiega l'attesa: la ricerca online è più lenta della base locale.
    const slowTimer = setTimeout(() => setSlow(true), 6_000);
    const fix = runtime.lastFix;
    const here = fix?.location;
    const nearby = here
      ? content.places
          .filter((p) => p.ref !== runtime.currentPlaceRef && distanceM(here, p.location) <= NEARBY_M)
          .slice(0, ASK_LIMITS.nearby)
          .map((p) => p.ref)
      : [];
    let answer: AskAnswer;
    try {
      // Con rete debole meglio un "non riesco" dopo un minuto che un'attesa senza fine
      // (la risposta con ricerca online può richiedere fino a ~50 secondi).
      const res = await fetch("/api/guide/ask", {
        signal: AbortSignal.timeout(65_000),
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          destination: content.destination,
          locale,
          question: q,
          currentPlace: runtime.currentPlaceRef,
          selectedPlace: selectedPlace ?? null,
          // La posizione serve solo al server per calcolare distanze e direzioni dai luoghi.
          position: fix && fixSource ? { lon: fix.location[0], lat: fix.location[1], accuracyM: Math.round(fix.accuracyM), simulated: fixSource === "simulated" } : null,
          nearby,
          told: runtime.memory.toldAssertions.slice(-ASK_LIMITS.told),
          history: answers.slice(-ASK_LIMITS.history).map((a) => ({ question: a.question, answer: a.answer.answer.slice(0, 1900) })),
          depth,
        }),
      });
      const body = (await res.json().catch(() => null)) as AskAnswer | null;
      answer = body && typeof body.answer === "string" ? body : fallbackAnswer(locale, "unavailable");
    } catch {
      answer = fallbackAnswer(locale, navigator.onLine ? "unavailable" : "offline");
    }
    // Ciò che la risposta ha raccontato entra nella memoria del giro: il racconto non lo ripeterà.
    if (answer.citations.length > 0) runtime.memory = rememberAssertions(runtime.memory, answer.citations);
    setAnswers((prev) => [...prev, { question: q, answer }]);
    voice?.enqueue([{ id: `answer-${Date.now()}`, text: answer.answer, title: t.askTitle }]);
    setQuestion("");
    clearTimeout(slowTimer);
    setSlow(false);
    setBusy(false);
  };

  const listen = () => {
    if (!Recognition) return;
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const r = new Recognition();
    r.lang = locale === "it" ? "it-IT" : "en-GB";
    r.interimResults = false;
    r.onresult = (e) => {
      const said = e.results[0]?.[0]?.transcript ?? "";
      setQuestion(said);
      void ask(said);
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recognitionRef.current = r;
    setListening(true);
    voice?.pause();
    r.start();
  };

  const last = answers.at(-1);
  // Si può approfondire una risposta della base locale, se il server ha la ricerca online.
  const canDeepen = webAvailable && online && last && last.answer.origin !== "web" && !last.answer.webUnavailable && last.answer.status !== "off_topic" && last.answer.status !== "unavailable";
  return (
    <section className="card ask" ref={sectionRef}>
      <h2>{t.askTitle}</h2>
      {about && <p className="muted small ask-context">{t.askContext(runtime.name(about))}</p>}
      {!online ? (
        <p className="muted small">{fallbackAnswer(locale, "offline").answer}</p>
      ) : (
        <form
          className="ask-form"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(question);
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={question}
            maxLength={ASK_LIMITS.questionChars}
            placeholder={t.askPlaceholder}
            aria-label={t.askTitle}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={busy}
          />
          {Recognition && (
            <button type="button" className={`button ${listening ? "on" : ""}`} onClick={listen} disabled={busy} aria-label={t.askVoice}>
              🎙
            </button>
          )}
          <button type="submit" className="button primary" disabled={busy || question.trim().length < 2}>
            {busy ? "…" : t.askSend}
          </button>
        </form>
      )}
      {busy && (
        <p className="muted small" aria-live="polite">
          {t.askBusy} {slow && t.askBusyLong}
        </p>
      )}
      {online && (
        <div className="ask-suggest">
          {t.askSuggest.map((q) => (
            <button key={q} type="button" className="chip small" disabled={busy} onClick={() => void ask(q)}>
              {q}
            </button>
          ))}
        </div>
      )}
      {last && (
        <div className="ask-answer" aria-live="polite">
          <p className="muted small">{last.question}</p>
          {last.answer.answer.split(/\n{2,}/).map((para, i) => (
            <p key={i}>{para}</p>
          ))}
          {last.answer.origin === "web" && <p className="muted small">🌐 {t.askWeb}</p>}
          {last.answer.citations.length > 0 && (
            <p className="muted small">{last.answer.inReview ? `⚠ ${t.askInReview}` : `✓ ${t.askVerified}`}</p>
          )}
          {last.answer.usedPosition && <p className="muted small">📍 {t.askPosition}</p>}
          <AnswerSources content={content} answer={last.answer} t={t} />
          {canDeepen && (
            <button type="button" className="chip small" disabled={busy} onClick={() => void ask(last.question, "deep")}>
              🔎 {t.askDeeper}
            </button>
          )}
          {debug && (
            <p className="muted small">
              debug · esito <code>{last.answer.status}</code>
              {last.answer.checkReason && <> · scartata: {last.answer.checkReason}</>}
              {last.answer.citations.length > 0 && <> · citazioni: {last.answer.citations.map((c) => c.split(":").pop()).join(", ")}</>}
              {last.answer.origin && <> · origine {last.answer.origin}</>}
              {last.answer.webSearches !== undefined && <> · ricerche web: {last.answer.webSearches}</>}
              {last.answer.cached && <> · dalla cache</>}
              {last.answer.webUnavailable && <> · ricerca web non disponibile</>}
              {last.answer.unsupportedNumbers && <> · numeri da verificare: {last.answer.unsupportedNumbers.join(", ")}</>}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

const safeUrl = (url: string | undefined) => (url && /^https?:\/\//i.test(url) ? url : undefined);

/**
 * «Fonti e approfondimenti»: le fonti della guida dietro le affermazioni citate e le pagine web
 * citate nella risposta, tenute distinte. Sezione chiusa per non disturbare la lettura.
 */
function AnswerSources(props: { content: BundleContent; answer: AskAnswer; t: UiText }) {
  const { content, answer, t } = props;
  const byRef = new Map(content.sources.map((s) => [s.ref, s]));
  const local = [
    ...new Set(answer.citations.flatMap((ref) => content.assertions.find((a) => a.ref === ref)?.sources ?? [])),
  ].flatMap((ref) => byRef.get(ref) ?? []);
  const web: WebSource[] = answer.webSources ?? [];
  if (local.length === 0 && web.length === 0) return null;
  return (
    <details className="ask-sources">
      <summary className="muted small">
        {t.askSources} ({local.length + web.length})
      </summary>
      {local.length > 0 && (
        <>
          <p className="muted small">{t.askSourcesLocal}</p>
          <ul>
            {local.map((s) => {
              const url = safeUrl(s.url);
              const meta = [s.institution, s.authors.join(", "), s.year].filter(Boolean).join(" · ");
              return (
                <li key={s.ref} className="small">
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer nofollow">
                      {s.title}
                    </a>
                  ) : (
                    s.title
                  )}
                  {meta && <span className="muted"> — {meta}</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {web.length > 0 && (
        <>
          <p className="muted small">{t.askSourcesWeb}</p>
          <ul>
            {web.map((s) => {
              const url = safeUrl(s.url);
              return (
                <li key={s.url} className="small">
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer nofollow">
                      {s.title}
                    </a>
                  ) : (
                    s.title
                  )}
                  <span className="muted">
                    {" "}
                    — {s.site} · {t.sourceTiers[s.tier - 1]}
                    {s.pageAge && <> · {s.pageAge}</>}
                  </span>
                  {s.citedText && <span className="muted cited">«{s.citedText}»</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </details>
  );
}
