"use client";

import { useRef, useState } from "react";
import type { BundleContent } from "@guide/bundle/client";
import { distanceM } from "@guide/context-engine";
import { rememberAssertions } from "@guide/narrative-planner";
import { ASK_LIMITS, fallbackAnswer, type AskAnswer } from "../lib/ask";
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
}) {
  const { content, runtime, voice, online, t } = props;
  const locale = content.locale === "it" ? "it" : "en";
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [answers, setAnswers] = useState<{ question: string; answer: AskAnswer }[]>([]);
  const recognitionRef = useRef<Recognition | null>(null);
  const Recognition = recognitionCtor();

  const ask = async (text: string) => {
    const q = text.trim();
    if (q.length < 2 || busy) return;
    setBusy(true);
    const here = runtime.lastFix?.location;
    const nearby = here
      ? content.places
          .filter((p) => p.ref !== runtime.currentPlaceRef && distanceM(here, p.location) <= NEARBY_M)
          .slice(0, ASK_LIMITS.nearby)
          .map((p) => p.ref)
      : [];
    let answer: AskAnswer;
    try {
      const res = await fetch("/api/guide/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          destination: content.destination,
          locale,
          question: q,
          currentPlace: runtime.currentPlaceRef,
          nearby,
          told: runtime.memory.toldAssertions.slice(-ASK_LIMITS.told),
          history: answers.slice(-ASK_LIMITS.history).map((a) => ({ question: a.question, answer: a.answer.answer })),
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
  return (
    <section className="card ask">
      <h2>{t.askTitle}</h2>
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
      {last && (
        <div className="ask-answer" aria-live="polite">
          <p className="muted small">{last.question}</p>
          <p>{last.answer.answer}</p>
          {last.answer.citations.length > 0 && (
            <p className="muted small">{last.answer.inReview ? `⚠ ${t.askInReview}` : `✓ ${t.askVerified}`}</p>
          )}
        </div>
      )}
    </section>
  );
}
