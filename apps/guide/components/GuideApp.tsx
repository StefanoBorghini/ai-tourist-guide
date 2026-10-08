"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { verifyBundle, type BundleContent, type BundleManifest } from "@guide/bundle/client";
import type { Fix, LngLat } from "@guide/context-engine";
import { GuideRuntime, type GuideMode, type NarrationSegment, type RuntimeEvent } from "../lib/runtime";
import { simulateWalk, type SimStop } from "../lib/simulator";
import { GuideVoice, type SpeechState } from "../lib/speech";
import { uiFor } from "../lib/i18n";
import { downloadBundle, isBundleCached, offlineSupported, registerServiceWorker } from "../lib/offline";
import { AskBox } from "./AskBox";
import { MiniMap } from "./MiniMap";

interface BundleEntry {
  destination: string;
  name: string;
  locale: string;
  fictional: boolean;
  manifest: string;
}

type Screen = "home" | "setup" | "walk";
const BUDGETS = [20, 30, 45, 60, 90];
const SIM_TICK_MS = 60;

function clock(ms: number, locale: string): string {
  return new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

export function GuideApp() {
  const [entries, setEntries] = useState<BundleEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [content, setContent] = useState<BundleContent | null>(null);
  const [bundleBase, setBundleBase] = useState("");
  const [opened, setOpened] = useState<{ url: string; manifest: BundleManifest } | null>(null);
  const [offline, setOffline] = useState<"no" | "downloading" | "yes" | "error">("no");
  const [progress, setProgress] = useState(0);
  const [online, setOnline] = useState(true);
  const [budget, setBudget] = useState(45);
  const [returnToAnchor, setReturnToAnchor] = useState(true);
  const [mode, setMode] = useState<GuideMode>("ask");
  const [avoidStairs, setAvoidStairs] = useState(false);
  const [, setTick] = useState(0);
  const [proposal, setProposal] = useState<{ placeRef: string; name: string } | null>(null);
  const [transcript, setTranscript] = useState<NarrationSegment[]>([]);
  const [speech, setSpeech] = useState<{ state: SpeechState; currentId: string | null }>({ state: "idle", currentId: null });
  const [rate, setRate] = useState(1);
  const [simulating, setSimulating] = useState(false);
  const [gps, setGps] = useState(false);
  const [complete, setComplete] = useState(false);

  const runtimeRef = useRef<GuideRuntime | null>(null);
  const voiceRef = useRef<GuideVoice | null>(null);
  const simRef = useRef<{ fixes: Fix[]; index: number; timer: ReturnType<typeof setInterval> | null }>({ fixes: [], index: 0, timer: null });
  const gpsWatchRef = useRef<number | null>(null);
  const speechStateRef = useRef<SpeechState>("idle");
  const proposalRef = useRef(proposal);
  proposalRef.current = proposal;

  const locale = content?.locale ?? (typeof navigator !== "undefined" && navigator.language.startsWith("it") ? "it" : "en");
  const t = uiFor(locale);
  const rerender = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    registerServiceWorker();
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    fetch("/bundles/index.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { bundles: BundleEntry[] }) => setEntries(d.bundles))
      .catch((e: Error) => setError(e.message));
  }, []);

  const openBundle = async (entry: BundleEntry) => {
    try {
      const manifest = (await (await fetch(entry.manifest)).json()) as BundleManifest;
      const base = entry.manifest.replace(/manifest\.json$/, "");
      const json = await (await fetch(base + manifest.content)).text();
      setContent(await verifyBundle(manifest, json));
      setBundleBase(base);
      setOpened({ url: entry.manifest, manifest });
      setOffline((await isBundleCached(entry.manifest, manifest).catch(() => false)) ? "yes" : "no");
      setScreen("setup");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleEvents = useCallback(
    (events: RuntimeEvent[]) => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      for (const e of events) {
        if (e.type === "proposal") setProposal({ placeRef: e.placeRef, name: e.name });
        if (e.type === "narration") {
          setTranscript((prev) => [...prev, ...e.segments]);
          voiceRef.current?.enqueue(e.segments.map((s) => ({ id: s.id, text: s.text, title: e.name })));
        }
        if (e.type === "tour_complete") setComplete(true);
      }
      rerender();
    },
    [rerender],
  );

  const stopSimulation = useCallback(() => {
    if (simRef.current.timer) clearInterval(simRef.current.timer);
    simRef.current.timer = null;
    setSimulating(false);
  }, []);

  const startTour = () => {
    if (!content) return;
    const now = Date.now();
    const runtime = new GuideRuntime(content, mode);
    const anchor = content.anchors[0];
    const start = anchor?.location ?? content.places[0]!.location;
    runtime.startTour({
      now,
      start,
      ...(returnToAnchor && anchor ? { anchor: { ref: anchor.ref, deadline: now + budget * 60_000 } } : { budgetMin: budget }),
      avoidStairs,
    });
    runtimeRef.current = runtime;
    voiceRef.current?.stop();
    voiceRef.current = GuideVoice.available()
      ? new GuideVoice(content.locale === "it" ? "it-IT" : "en-GB", (state, current) => {
          speechStateRef.current = state;
          setSpeech({ state, currentId: current?.id ?? null });
        })
      : null;
    setTranscript([]);
    setProposal(null);
    setComplete(false);
    setScreen("walk");
  };

  const startSimulation = () => {
    const runtime = runtimeRef.current;
    if (!runtime?.plan || !content) return;
    const from: LngLat = runtime.lastFix?.location ?? content.anchors[0]?.location ?? content.places[0]!.location;
    const remaining = runtime.plan.stops.filter((s) => !runtime.visited.includes(s.placeId));
    const stops: SimStop[] = remaining.map((s) => ({ location: content.places.find((p) => p.ref === s.placeId)!.location, dwellS: 25 }));
    if (runtime.anchor) stops.push({ location: runtime.anchor.location, dwellS: 5 });
    simRef.current = { fixes: simulateWalk(from, stops, { startTime: runtime.lastFix?.timestamp ?? Date.now() }), index: 0, timer: null };
    setSimulating(true);
    simRef.current.timer = setInterval(() => {
      // Come una persona vera: ci si ferma mentre la guida parla o aspetta una risposta.
      if (speechStateRef.current === "speaking" || proposalRef.current) return;
      const fix = simRef.current.fixes[simRef.current.index++];
      if (!fix) return stopSimulation();
      handleEvents(runtimeRef.current!.onFix(fix));
    }, SIM_TICK_MS);
  };

  const toggleGps = () => {
    if (gps) {
      if (gpsWatchRef.current !== null) navigator.geolocation.clearWatch(gpsWatchRef.current);
      gpsWatchRef.current = null;
      setGps(false);
      return;
    }
    if (!("geolocation" in navigator)) return;
    stopSimulation();
    gpsWatchRef.current = navigator.geolocation.watchPosition(
      (p) =>
        handleEvents(
          runtimeRef.current!.onFix({
            location: [p.coords.longitude, p.coords.latitude],
            accuracyM: p.coords.accuracy,
            timestamp: p.timestamp,
            speedMs: p.coords.speed ?? undefined,
          }),
        ),
      () => setGps(false),
      { enableHighAccuracy: true, maximumAge: 2000 },
    );
    setGps(true);
  };

  useEffect(() => () => {
    stopSimulation();
    voiceRef.current?.stop();
    if (gpsWatchRef.current !== null) navigator.geolocation.clearWatch(gpsWatchRef.current);
  }, [stopSimulation]);

  const runtime = runtimeRef.current;
  const currentSegment = useMemo(() => transcript.find((s) => s.id === speech.currentId) ?? null, [transcript, speech.currentId]);

  const saveOffline = async () => {
    if (!opened) return;
    setOffline("downloading");
    setProgress(0);
    try {
      await downloadBundle(opened.url, opened.manifest, setProgress);
      setOffline("yes");
    } catch {
      setOffline("error");
    }
  };

  // ------------------------------------------------------------------ schermate

  if (screen === "home") {
    const byDestination = new Map<string, BundleEntry[]>();
    for (const e of entries) byDestination.set(e.destination, [...(byDestination.get(e.destination) ?? []), e]);
    return (
      <main className="screen">
        <p className="eyebrow">AI Guide</p>
        <h1>{t.tagline}</h1>
        <h2>{t.chooseDestination}</h2>
        {!online && <p className="notice">{t.offlineNow}</p>}
        {error && <p className="error">{online ? error : t.offlineNoBundle}</p>}
        <div className="stack">
          {[...byDestination.values()].map((group) => (
            <div key={group[0]!.destination} className="card">
              <strong>{group[0]!.name}</strong>
              {group[0]!.fictional && <span className="badge">{t.fictional}</span>}
              <div className="row">
                {group.map((e) => (
                  <button key={e.locale} className="button" onClick={() => openBundle(e)}>
                    {e.locale === "it" ? "Italiano" : "English"}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </main>
    );
  }

  if (screen === "setup" && content) {
    const anchor = content.anchors[0];
    return (
      <main className="screen">
        <button className="link" onClick={() => setScreen("home")}>← {t.back}</button>
        <h1>{content.name}</h1>
        {content.fictional && <p className="notice">{t.fictionalNote}</p>}
        <h2>{t.howLong}</h2>
        <div className="row wrap">
          {BUDGETS.map((b) => (
            <button key={b} className={`chip ${budget === b ? "on" : ""}`} onClick={() => setBudget(b)}>
              {b} {t.minutes}
            </button>
          ))}
        </div>
        {anchor && (
          <label className="check">
            <input type="checkbox" checked={returnToAnchor} onChange={(e) => setReturnToAnchor(e.target.checked)} />
            {t.returnTo} {anchor.name} {t.by} {clock(Date.now() + budget * 60_000, locale)}
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={avoidStairs} onChange={(e) => setAvoidStairs(e.target.checked)} />
          {t.avoidStairs}
        </label>
        <h2>{t.mode}</h2>
        <div className="row wrap">
          {(["ask", "auto", "silent"] as const).map((m) => (
            <button key={m} className={`chip ${mode === m ? "on" : ""}`} onClick={() => setMode(m)}>
              {t.modes[m]}
            </button>
          ))}
        </div>
        {content.safetyNotes.map((n) => (
          <p key={n.id} className="notice">⚠ {n.text}</p>
        ))}
        {offlineSupported() && opened && (
          <div className="offline-box">
            {offline === "yes" ? (
              <p className="ok">✓ {t.offlineReady}</p>
            ) : (
              <>
                <button className="button" disabled={offline === "downloading" || !online} onClick={saveOffline}>
                  ⬇ {t.offlineDownload} ({Math.ceil(opened.manifest.totalBytes / 1024)} KB)
                </button>
                {offline === "downloading" && <p className="muted small">{Math.round(progress * 100)}%</p>}
                {offline === "error" && <p className="error">{t.offlineError}</p>}
                <p className="muted small">{t.offlineHint}</p>
              </>
            )}
          </div>
        )}
        <button className="button primary big" onClick={startTour}>{t.start}</button>
      </main>
    );
  }

  if (!runtime || !content) return null;
  // La prossima tappa non si mostra se è il luogo in cui ci si trova già.
  const nextStop = runtime.nextStop !== runtime.currentPlaceRef ? runtime.nextStop : null;
  const nextPlace = nextStop ? content.places.find((p) => p.ref === nextStop) : null;
  const anchorStatus = runtime.lastAnchorStatus;
  const anchorName = runtime.anchor ? runtime.name(runtime.anchor.id) : "";

  return (
    <main className="screen walk">
      <header className="walk-header">
        <button className="link" onClick={() => { stopSimulation(); voiceRef.current?.stop(); setScreen("setup"); }}>← {t.back}</button>
        <strong>{content.name}</strong>
        {content.fictional && <span className="badge">{t.fictional}</span>}
        {!online && <span className="badge offline">{t.offlineBadge}</span>}
      </header>

      {complete && <p className="notice success">{t.complete}</p>}

      {proposal && (
        <section className="card proposal" role="alert">
          <p>{t.arrivedAsk(proposal.name)}</p>
          <div className="row">
            <button className="button primary" onClick={() => { setProposal(null); handleEvents(runtime.acceptProposal(Date.now())); }}>{t.yes}</button>
            <button className="button" onClick={() => { runtime.declineProposal(); setProposal(null); }}>{t.no}</button>
          </div>
        </section>
      )}

      <section className="card now-playing" aria-live="polite">
        <p className="eyebrow">{speech.state === "idle" ? (runtime.currentPlaceRef ? `${t.here}: ${runtime.name(runtime.currentPlaceRef)}` : " ") : t.listening}</p>
        {runtime.currentPlaceRef && <PlacePhoto content={content} placeRef={runtime.currentPlaceRef} base={bundleBase} label={t.photo} />}
        <p className="now-text">{currentSegment?.text ?? (transcript.length === 0 ? t.nothing : transcript.at(-1)!.text)}</p>
        {!voiceRef.current && <p className="muted small">{t.noVoice}</p>}
        <div className="controls">
          <button className="button big" disabled={speech.state === "idle"} onClick={() => voiceRef.current?.toggle()}>
            {speech.state === "paused" ? `▶ ${t.play}` : `❚❚ ${t.pause}`}
          </button>
          <button className="button" disabled={speech.state === "idle"} onClick={() => voiceRef.current?.skip()}>⏭ {t.skip}</button>
          <button
            className="button"
            onClick={() => {
              const next = rate >= 1.5 ? 0.75 : rate + 0.25;
              setRate(next);
              voiceRef.current?.setRate(next);
            }}
          >
            {t.speed} {rate}×
          </button>
        </div>
        {runtime.currentPlaceRef && speech.state === "idle" && !proposal && (
          <button className="button" onClick={() => handleEvents(runtime.narrate(runtime.currentPlaceRef))}>{t.tellMe}</button>
        )}
      </section>

      <section className="card status">
        {nextPlace && (
          <p>
            <span className="muted">{t.next}:</span> <strong>{nextPlace.name}</strong>
          </p>
        )}
        {anchorStatus && (
          <p className={`anchor ${anchorStatus.level}`}>
            {anchorStatus.level === "ok" || anchorStatus.level === "soon"
              ? t.anchor[anchorStatus.level](anchorName, clock(anchorStatus.leaveBy, locale))
              : t.anchor[anchorStatus.level](anchorName)}
          </p>
        )}
        {runtime.plan?.status === "no_time" && <p className="anchor late">{t.noPlan}</p>}
      </section>

      <AskBox content={content} runtime={runtime} voice={voiceRef.current} online={online} t={t} />

      <MiniMap content={content} runtime={runtime} />

      <section className="card">
        <h2>{t.plan}</h2>
        <ol className="plan">
          {runtime.plan?.stops.map((s) => (
            <li key={s.placeId} className={runtime.visited.includes(s.placeId) ? "done" : ""}>
              {runtime.name(s.placeId)} {runtime.visited.includes(s.placeId) && <span className="muted">· {t.visited}</span>}
            </li>
          ))}
        </ol>
      </section>

      <section className="card row wrap">
        {!simulating ? (
          <button className="button" onClick={startSimulation} disabled={gps}>🚶 {t.simulate}</button>
        ) : (
          <button className="button" onClick={stopSimulation}>■ {t.stopSim}</button>
        )}
        <button className={`button ${gps ? "on" : ""}`} onClick={toggleGps}>📍 {gps ? t.gpsOn : t.useGps}</button>
        {simulating && <span className="muted small">{t.simulating}</span>}
      </section>

      {transcript.length > 0 && (
        <details className="card">
          <summary>{t.transcript}</summary>
          {transcript.map((s) => (
            <p key={s.id} className={s.kind === "bridge" ? "bridge" : ""}>{s.text}</p>
          ))}
        </details>
      )}
    </main>
  );
}

/** Prima immagine del luogo, con il credito richiesto dalla licenza. */
function PlacePhoto({ content, placeRef, base, label }: { content: BundleContent; placeRef: string; base: string; label: string }) {
  const media = content.media.find((m) => m.subjects.includes(placeRef));
  if (!media) return null;
  const credit = media.attribution ?? (media.author ? `${label}: ${media.author}` : null);
  return (
    <figure className="place-photo">
      {/* eslint-disable-next-line @next/next/no-img-element -- file statico del bundle, già ottimizzato */}
      <img src={base + media.path} alt={media.alt} loading="lazy" />
      {(media.caption || credit) && (
        <figcaption>
          {media.caption && <span>{media.caption}</span>}
          {credit && (
            <span className="credit">
              {media.originalUrl ? <a href={media.originalUrl} target="_blank" rel="noreferrer">{credit}</a> : credit}
            </span>
          )}
        </figcaption>
      )}
    </figure>
  );
}
