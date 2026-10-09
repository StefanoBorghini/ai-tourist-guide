"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { verifyBundle, type BundleContent, type BundleManifest } from "@guide/bundle/client";
import type { Fix, LngLat } from "@guide/context-engine";
import { GuideRuntime, type GuideMode, type NarrationSegment, type RuntimeEvent, type RuntimeState, type TourOptions } from "../lib/runtime";
import type { PositionSource } from "../lib/field-points";
import { simulateWalk, type SimStop } from "../lib/simulator";
import { GuideVoice, type SpeechState } from "../lib/speech";
import { uiFor } from "../lib/i18n";
import { downloadBundle, isBundleCached, offlineSupported, registerServiceWorker } from "../lib/offline";
import { AskBox } from "./AskBox";
import { DebugPanel } from "./DebugPanel";
import { MapView } from "./MapView";

interface BundleEntry {
  destination: string;
  name: string;
  locale: string;
  fictional: boolean;
  /** Bundle di anteprima: territorio con contenuti ancora in revisione. */
  preview?: boolean;
  manifest: string;
}

type Screen = "home" | "setup" | "walk";
const BUDGETS = [20, 30, 45, 60, 90];
/** Giro salvato per riprenderlo se il telefono chiude o ricarica la pagina (es. dopo aver usato la fotocamera). */
const SAVED_TOUR_KEY = "guide-tour/1";
const SAVED_TOUR_MAX_AGE_MS = 12 * 3_600_000;
interface SavedTour {
  entry: BundleEntry;
  mode: GuideMode;
  options: TourOptions;
  start: [number, number];
  state: RuntimeState;
  savedAt: number;
}
function readSavedTour(): SavedTour | null {
  try {
    const raw = localStorage.getItem(SAVED_TOUR_KEY);
    const saved = raw ? (JSON.parse(raw) as SavedTour) : null;
    return saved && Date.now() - saved.savedAt < SAVED_TOUR_MAX_AGE_MS ? saved : null;
  } catch {
    return null;
  }
}
function clearSavedTour(): void {
  try {
    localStorage.removeItem(SAVED_TOUR_KEY);
  } catch {
    // memoria non disponibile
  }
}
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
  const [askAvailable, setAskAvailable] = useState(false);
  const [budget, setBudget] = useState(45);
  const [routeRef, setRouteRef] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [fixSource, setFixSource] = useState<PositionSource | null>(null);
  const [savedTour, setSavedTour] = useState<SavedTour | null>(null);
  const openedEntryRef = useRef<BundleEntry | null>(null);
  const tourOptionsRef = useRef<TourOptions | null>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
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
  /** Punto di partenza del giro (ancora o prima tappa del percorso): da qui parte anche la simulazione. */
  const tourStartRef = useRef<LngLat | null>(null);
  const speechStateRef = useRef<SpeechState>("idle");
  const proposalRef = useRef(proposal);
  proposalRef.current = proposal;

  // La lingua del dispositivo si legge dopo il montaggio: il server non la conosce
  // e leggerla durante il rendering produce un'idratazione diversa (errore React #418).
  const [deviceLocale, setDeviceLocale] = useState<"it" | "en">("en");
  useEffect(() => setDeviceLocale(navigator.language.startsWith("it") ? "it" : "en"), []);
  const locale = content?.locale ?? deviceLocale;
  const t = uiFor(locale);
  const rerender = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    // Modalità debug: ?debug=1 nell'indirizzo la attiva e la ricorda su questo dispositivo.
    try {
      const q = new URLSearchParams(window.location.search).get("debug");
      if (q !== null) localStorage.setItem("guide-debug", q === "0" ? "0" : "1");
      setDebug(localStorage.getItem("guide-debug") === "1");
    } catch {
      setDebug(new URLSearchParams(window.location.search).get("debug") === "1");
    }
  }, []);

  useEffect(() => {
    // Senza rete le domande non sono possibili: inutile chiederlo al server.
    if (!navigator.onLine) {
      setAskAvailable(false);
      return;
    }
    fetch("/api/guide/ask", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { available: false }))
      .then((d: { available?: boolean }) => setAskAvailable(d.available === true))
      .catch(() => setAskAvailable(false));
  }, [online]);

  // Si invita a fare domande solo quando si possono davvero fare.
  useEffect(() => {
    if (runtimeRef.current) runtimeRef.current.inviteQuestions = online && askAvailable;
  }, [online, askAvailable]);

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

  useEffect(() => setSavedTour(readSavedTour()), []);

  /** Scarica (o legge dalla cache) e verifica il bundle di una destinazione. */
  const loadBundle = async (entry: BundleEntry): Promise<BundleContent> => {
    const manifest = (await (await fetch(entry.manifest)).json()) as BundleManifest;
    const base = entry.manifest.replace(/manifest\.json$/, "");
    const json = await (await fetch(base + manifest.content)).text();
    const verified = await verifyBundle(manifest, json);
    setContent(verified);
    setBundleBase(base);
    setOpened({ url: entry.manifest, manifest });
    openedEntryRef.current = entry;
    setOffline((await isBundleCached(entry.manifest, manifest).catch(() => false)) ? "yes" : "no");
    return verified;
  };

  const openBundle = async (entry: BundleEntry) => {
    try {
      await loadBundle(entry);
      setScreen("setup");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveTour = useCallback(() => {
    const runtime = runtimeRef.current;
    const entry = openedEntryRef.current;
    const options = tourOptionsRef.current;
    if (!runtime || !entry || !options || !tourStartRef.current) return;
    try {
      const saved: SavedTour = { entry, mode: runtime.mode, options, start: [tourStartRef.current[0], tourStartRef.current[1]], state: runtime.exportState(), savedAt: Date.now() };
      localStorage.setItem(SAVED_TOUR_KEY, JSON.stringify(saved));
    } catch {
      // memoria non disponibile: il giro non sarà ripristinabile
    }
  }, []);

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
      // Un giro finito non va riproposto alla riapertura.
      if (events.some((e) => e.type === "tour_complete")) clearSavedTour();
      else if (events.length > 0) saveTour();
      rerender();
    },
    [rerender, saveTour],
  );

  const stopSimulation = useCallback(() => {
    if (simRef.current.timer) clearInterval(simRef.current.timer);
    simRef.current.timer = null;
    setSimulating(false);
  }, []);

  /** Avvia un giro (nuovo o ripreso da uno stato salvato). */
  const beginTour = (tourContent: BundleContent, tourMode: GuideMode, options: TourOptions, start: LngLat, state?: RuntimeState) => {
    const runtime = new GuideRuntime(tourContent, tourMode);
    runtime.inviteQuestions = online && askAvailable;
    runtime.startTour(options);
    if (state) runtime.restoreState(state);
    runtimeRef.current = runtime;
    tourOptionsRef.current = options;
    tourStartRef.current = start;
    voiceRef.current?.stop();
    voiceRef.current = GuideVoice.available()
      ? new GuideVoice(tourContent.locale === "it" ? "it-IT" : "en-GB", (state, current) => {
          speechStateRef.current = state;
          setSpeech({ state, currentId: current?.id ?? null });
        })
      : null;
    setTranscript([]);
    setProposal(null);
    setComplete(false);
    setFixSource(null);
    setScreen("walk");
    saveTour();
  };

  const startTour = () => {
    if (!content) return;
    const now = Date.now();
    const anchor = content.anchors[0];
    const route = routeRef ? content.routes.find((r) => r.ref === routeRef) : undefined;
    // Con un percorso curato si parte dalla sua prima tappa; altrimenti dall'ancora (o dal primo luogo).
    const firstStop = route ? content.places.find((p) => p.ref === route.stops[0]?.place) : undefined;
    const start = firstStop?.location ?? anchor?.location ?? content.places[0]!.location;
    beginTour(content, mode, {
      now,
      start,
      ...(route
        ? { route: route.ref, budgetMin: route.durationMin }
        : returnToAnchor && anchor
          ? { anchor: { ref: anchor.ref, deadline: now + budget * 60_000 } }
          : { budgetMin: budget }),
      avoidStairs,
    }, start);
  };

  const resumeTour = async (saved: SavedTour) => {
    try {
      const loaded = await loadBundle(saved.entry);
      setMode(saved.mode);
      if (saved.options.route) setRouteRef(saved.options.route);
      beginTour(loaded, saved.mode, saved.options, saved.start, saved.state);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Avanzamento manuale: quando il GPS è impreciso o le coordinate del luogo sono sbagliate. */
  const arriveHere = (placeRef: string) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setProposal(null);
    handleEvents(runtime.arriveManually(placeRef, Date.now()));
  };
  const skipStop = (placeRef: string) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const events = runtime.skipStop(placeRef);
    saveTour();
    handleEvents(events);
  };

  const startSimulation = () => {
    const runtime = runtimeRef.current;
    if (!runtime?.plan || !content) return;
    const from: LngLat = runtime.lastFix?.location ?? tourStartRef.current ?? content.places[0]!.location;
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
      setFixSource("simulated");
      handleEvents(runtimeRef.current!.onFix(fix));
    }, SIM_TICK_MS);
  };

  /** Tiene lo schermo acceso mentre il GPS è attivo: a schermo spento il browser sospende la posizione. */
  const requestWakeLock = useCallback(async () => {
    try {
      const wl = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
      if (wl && !wakeLockRef.current) wakeLockRef.current = await wl.request("screen");
    } catch {
      // non supportato o rifiutato (es. batteria scarica): si continua senza
    }
  }, []);
  const releaseWakeLock = useCallback(() => {
    void wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
  }, []);

  const stopGps = useCallback(() => {
    if (gpsWatchRef.current !== null) navigator.geolocation.clearWatch(gpsWatchRef.current);
    gpsWatchRef.current = null;
    setGps(false);
    releaseWakeLock();
  }, [releaseWakeLock]);

  const toggleGps = () => {
    if (gps) return stopGps();
    if (!("geolocation" in navigator)) {
      setGpsError(t.gpsUnavailable);
      return;
    }
    stopSimulation();
    setGpsError(null);
    gpsWatchRef.current = navigator.geolocation.watchPosition(
      (p) => {
        setFixSource("gps");
        setGpsError(null);
        handleEvents(
          runtimeRef.current!.onFix({
            location: [p.coords.longitude, p.coords.latitude],
            accuracyM: p.coords.accuracy,
            timestamp: p.timestamp,
            speedMs: p.coords.speed ?? undefined,
          }),
        );
      },
      (err) => {
        // 1 = permesso negato: inutile insistere. 2-3 = segnale assente o lento: si continua ad ascoltare.
        if (err.code === 1) {
          setGpsError(t.gpsDenied);
          stopGps();
        } else {
          setGpsError(err.code === 3 ? t.gpsTimeout : t.gpsNoSignal);
        }
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20_000 },
    );
    setGps(true);
    void requestWakeLock();
  };

  // Lo schermo acceso va richiesto di nuovo quando l'app torna in primo piano.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && gpsWatchRef.current !== null) {
        wakeLockRef.current = null;
        void requestWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [requestWakeLock]);

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
        {savedTour && (
          <div className="card resume">
            <strong>{t.resumeTitle}: {savedTour.entry.name}</strong>
            <span className="muted small">
              {t.resumeSaved} {clock(savedTour.savedAt, locale)} · {savedTour.state.memory.visitedPlaces.length} {t.resumeVisited}
            </span>
            <div className="row">
              <button className="button primary" onClick={() => void resumeTour(savedTour)}>{t.resume}</button>
              <button className="button" onClick={() => { clearSavedTour(); setSavedTour(null); }}>{t.resumeDiscard}</button>
            </div>
          </div>
        )}
        <div className="stack">
          {[...byDestination.values()].map((group) => (
            <div key={group[0]!.destination} className="card">
              <strong>{group[0]!.name}</strong>
              {group[0]!.fictional && <span className="badge">{t.fictional}</span>}
              {group[0]!.preview && <span className="badge preview">{t.previewBadge}</span>}
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
        {content.preview && <p className="notice preview">{t.previewNote}</p>}
        {content.routes.length > 0 && (
          <>
            <h2>{t.routeTitle}</h2>
            <div className="stack">
              <button className={`chip ${routeRef === null ? "on" : ""}`} onClick={() => setRouteRef(null)}>
                {t.routeFree}
              </button>
              {content.routes.map((r) => (
                <button key={r.ref} className={`chip route ${routeRef === r.ref ? "on" : ""}`} onClick={() => setRouteRef(r.ref)}>
                  <span>{r.name}</span>
                  <span className="muted small">
                    {r.durationMin} {t.minutes}
                    {r.difficulty && <> · {t.difficulty[r.difficulty]}</>}
                    {r.elevationGainM !== undefined && <> · +{r.elevationGainM} m</>}
                    {r.calibration === "draft" && <> · {t.routeDraft}</>}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        {routeRef === null && <h2>{t.howLong}</h2>}
        {routeRef === null && <div className="row wrap">
          {BUDGETS.map((b) => (
            <button key={b} className={`chip ${budget === b ? "on" : ""}`} onClick={() => setBudget(b)}>
              {b} {t.minutes}
            </button>
          ))}
        </div>}
        {anchor && routeRef === null && (
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
        <button className="link" onClick={() => { stopSimulation(); stopGps(); voiceRef.current?.stop(); setScreen("setup"); }}>← {t.back}</button>
        <strong>{content.name}</strong>
        {content.fictional && <span className="badge">{t.fictional}</span>}
        {!online && <span className="badge offline">{t.offlineBadge}</span>}
        {content.preview && <span className="badge preview">{t.previewBadge}</span>}
        <button className={`link debug-toggle ${debug ? "on" : ""}`} onClick={() => {
          const next = !debug;
          setDebug(next);
          try { localStorage.setItem("guide-debug", next ? "1" : "0"); } catch { /* memoria non disponibile */ }
        }} aria-pressed={debug}>
          debug
        </button>
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

      {gpsError && <p className="notice gps-error" role="alert">📍 {gpsError}</p>}
      {gps && fixSource === "gps" && runtime.lastFix && runtime.lastFix.accuracyM > 35 && (
        <p className="notice" role="status">{t.gpsImprecise(Math.round(runtime.lastFix.accuracyM))}</p>
      )}

      <section className="card status">
        {nextPlace && (
          <p>
            <span className="muted">{t.next}:</span> <strong>{nextPlace.name}</strong>
          </p>
        )}
        {runtime.nextStop && (
          <div className="manual">
            <p className="muted small">{t.manualHint}</p>
            <div className="row wrap">
              <button className="button" onClick={() => arriveHere(runtime.nextStop!)}>📍 {t.imHere}: {runtime.name(runtime.nextStop)}</button>
              {runtime.routeStops && (
                <button className="button" onClick={() => skipStop(runtime.nextStop!)}>⏭ {t.skipStop}</button>
              )}
            </div>
          </div>
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

      {debug && (
        <DebugPanel
          content={content}
          runtime={runtime}
          gpsError={gpsError}
          fixSource={fixSource}
          online={online}
          offlineReady={offlineSupported() ? offline === "yes" : null}
          bundleHash={opened?.manifest.kbHash ?? null}
        />
      )}

      {askAvailable && <AskBox content={content} runtime={runtime} voice={voiceRef.current} online={online} t={t} />}

      <MapView content={content} runtime={runtime} debug={debug} online={online} simulated={fixSource === "simulated"} t={t} />

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
