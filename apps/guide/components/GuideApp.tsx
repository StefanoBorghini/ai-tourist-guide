"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { verifyBundle, type BundleContent, type BundleManifest } from "@guide/bundle/client";
import { distanceM, type Fix, type LngLat } from "@guide/context-engine";
import { GuideRuntime, type GuideMode, type NarrationSegment, type RuntimeEvent, type RuntimeKind, type RuntimeState, type TourOptions } from "../lib/runtime";
import type { PositionSource } from "../lib/field-points";
import { gpsStatus, type GpsErrorCode, type GpsStatus } from "../lib/gps-status";
import { compass, formatDistance } from "../lib/format";
import { simulateWalk, type SimStop } from "../lib/simulator";
import { GuideVoice, type SpeechState } from "../lib/speech";
import { uiFor, type UiText } from "../lib/i18n";
import { downloadBundle, isBundleCached, offlineSupported, registerServiceWorker } from "../lib/offline";
import { AskBox } from "./AskBox";
import { DebugPanel } from "./DebugPanel";
import { MapView } from "./MapView";
import { PlaceCard, PlacePhoto } from "./PlaceCard";

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
  /** Esplorazione libera o itinerario; assente nei salvataggi precedenti (erano tutti itinerari). */
  kind?: RuntimeKind;
  /** Opzioni dell'itinerario; null in esplorazione. */
  options: TourOptions | null;
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
/** Assenza dal primo piano oltre la quale si avvisa che la guida era in pausa. */
const BACKGROUND_NOTICE_MS = 30_000;
/** Luoghi mostrati nell'elenco «Vicino a te». */
const NEARBY_COUNT = 5;

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
  /** Impronte dei bundle con cui risponde il server delle domande (per il debug). */
  const [webAvailable, setWebAvailable] = useState(false);
  const [serverBundles, setServerBundles] = useState<{ destination: string; locale: string; kbHash: string }[] | null>(null);
  const [budget, setBudget] = useState(45);
  const [routeRef, setRouteRef] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);
  const [gpsError, setGpsError] = useState<GpsErrorCode | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [askFocus, setAskFocus] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const [pausedNotice, setPausedNotice] = useState(false);
  const [itinerariesOpen, setItinerariesOpen] = useState(false);
  const hiddenAtRef = useRef<number | null>(null);
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
      .then((d: { available?: boolean; bundles?: { destination: string; locale: string; kbHash: string }[]; web?: { enabled?: boolean; supported?: boolean | null } }) => {
        setAskAvailable(d.available === true);
        setWebAvailable(d.available === true && d.web?.enabled === true && d.web.supported !== false);
        setServerBundles(Array.isArray(d.bundles) ? d.bundles : null);
      })
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
    if (!runtime || !runtime.kind || !entry || !tourStartRef.current) return;
    if (runtime.kind === "tour" && !options) return;
    try {
      const saved: SavedTour = {
        entry,
        mode: runtime.mode,
        kind: runtime.kind,
        options: runtime.kind === "tour" ? options : null,
        start: [tourStartRef.current[0], tourStartRef.current[1]],
        state: runtime.exportState(),
        savedAt: Date.now(),
      };
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
        if (e.type === "nothing_new") setFlash(t.alreadyTold);
      }
      // Un giro finito non va riproposto alla riapertura.
      if (events.some((e) => e.type === "tour_complete")) clearSavedTour();
      else if (events.length > 0) saveTour();
      rerender();
    },
    [rerender, saveTour, t],
  );

  const stopSimulation = useCallback(() => {
    if (simRef.current.timer) clearInterval(simRef.current.timer);
    simRef.current.timer = null;
    setSimulating(false);
  }, []);

  /** Avvia un'esplorazione o un itinerario (nuovo o ripreso da uno stato salvato). */
  const beginSession = (tourContent: BundleContent, tourMode: GuideMode, options: TourOptions | null, start: LngLat, state?: RuntimeState) => {
    // Visita già in corso sullo stesso territorio: si cambia solo organizzazione, il contesto resta.
    const current = runtimeRef.current;
    if (!state && current && current.content === tourContent && current.memory.visitedPlaces.length > 0) {
      current.mode = tourMode;
      reorganize(options, start);
      setScreen("walk");
      return;
    }
    const runtime = new GuideRuntime(tourContent, tourMode);
    runtime.inviteQuestions = online && askAvailable;
    if (options) runtime.startTour(options);
    else runtime.startExplore();
    if (state) runtime.restoreState(state);
    runtimeRef.current = runtime;
    tourOptionsRef.current = options;
    tourStartRef.current = start;
    voiceRef.current?.stop();
    voiceRef.current = GuideVoice.available()
      ? new GuideVoice(tourContent.locale === "it" ? "it-IT" : "en-GB", (state, current) => {
          speechStateRef.current = state;
          // Mentre la guida parla, i luoghi raggiunti aspettano: niente interruzioni.
          if (runtimeRef.current) runtimeRef.current.narrating = state === "speaking";
          setSpeech({ state, currentId: current?.id ?? null });
        })
      : null;
    setTranscript([]);
    setProposal(null);
    setComplete(false);
    setSelected(null);
    setFlash(null);
    setScreen("walk");
    saveTour();
  };

  /** Punto di partenza della simulazione quando non c'è ancora una posizione. */
  const defaultStart = (c: BundleContent): LngLat => c.anchors[0]?.location ?? c.places[0]!.location;

  const startExploring = () => {
    if (!content) return;
    beginSession(content, mode, null, defaultStart(content));
    // Il tocco su «Inizia a esplorare» è anche il gesto che autorizza la richiesta della posizione.
    startGps();
  };

  /**
   * Cambia l'organizzazione della visita (esplorazione libera ↔ percorso guidato) senza perderla:
   * stesso runtime, stessa memoria del racconto, stesso GPS e stesso testo già ascoltato.
   */
  const reorganize = (options: TourOptions | null, start?: LngLat) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (options) runtime.startTour({ ...options, keepMemory: true });
    else runtime.startExplore({ keepMemory: true });
    tourOptionsRef.current = options;
    if (start) tourStartRef.current = start;
    setProposal(null);
    setComplete(false);
    setSelected(null);
    stopSimulation();
    setFlash(t.switchKeeps);
    saveTour();
    rerender();
  };
  const switchToExplore = () => reorganize(null);
  /** Percorso curato scelto durante la visita: parte da dove si è (o dalla sua prima tappa). */
  const switchToRoute = (ref: string) => {
    const runtime = runtimeRef.current;
    const route = content?.routes.find((r) => r.ref === ref);
    if (!runtime || !route || !content) return;
    const first = content.places.find((p) => p.ref === route.stops[0]?.place)?.location;
    const start = runtime.lastFix?.location ?? first ?? defaultStart(content);
    setRouteRef(ref);
    reorganize({ now: Date.now(), start, route: ref, budgetMin: route.durationMin, avoidStairs }, start);
  };

  const startTour = () => {
    if (!content) return;
    const now = Date.now();
    const anchor = content.anchors[0];
    const route = routeRef ? content.routes.find((r) => r.ref === routeRef) : undefined;
    // Con un percorso curato si parte dalla sua prima tappa; altrimenti dall'ancora (o dal primo luogo).
    const firstStop = route ? content.places.find((p) => p.ref === route.stops[0]?.place) : undefined;
    const start = firstStop?.location ?? anchor?.location ?? content.places[0]!.location;
    beginSession(content, mode, {
      now,
      start,
      ...(route
        ? { route: route.ref, budgetMin: route.durationMin }
        : returnToAnchor && anchor
          ? { anchor: { ref: anchor.ref, deadline: now + budget * 60_000 } }
          : { budgetMin: budget }),
      avoidStairs,
    }, start);
    // Anche il percorso guidato usa il GPS reale per riconoscere le tappe.
    startGps();
  };

  const resumeTour = async (saved: SavedTour) => {
    try {
      const loaded = await loadBundle(saved.entry);
      setMode(saved.mode);
      const options = saved.kind === "explore" ? null : saved.options;
      if (options?.route) setRouteRef(options.route);
      beginSession(loaded, saved.mode, options, saved.start, saved.state);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Avanzamento manuale: quando il GPS è impreciso o le coordinate del luogo sono sbagliate. */
  const arriveHere = (placeRef: string) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setProposal(null);
    setSelected(null);
    voiceRef.current?.stop();
    handleEvents(runtime.arriveManually(placeRef, Date.now()));
  };

  /** «Ascolta la storia» di un luogo qualsiasi, anche lontano (scelto sulla mappa o nell'elenco). */
  const listenTo = (placeRef: string) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setFlash(null);
    if (runtime.wasNarrated(placeRef)) {
      // Già raccontato: si riascolta lo stesso testo (la memoria del giro non lo ripete come nuovo).
      const told = transcript.filter((s) => s.placeRef === placeRef);
      if (told.length === 0) return setFlash(t.alreadyTold);
      voiceRef.current?.stop();
      voiceRef.current?.enqueue(told.map((s) => ({ id: s.id, text: s.text, title: runtime.name(placeRef) })));
      return;
    }
    if (![...runtime.library.units.values()].some((u) => u.anchor === placeRef)) return setFlash(t.noStory);
    if (proposalRef.current?.placeRef === placeRef) setProposal(null);
    voiceRef.current?.stop();
    handleEvents(runtime.narrate(placeRef, Date.now()));
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
    if (!runtime || !content) return;
    const from: LngLat = runtime.lastFix?.location ?? tourStartRef.current ?? content.places[0]!.location;
    const at = (ref: string) => content.places.find((p) => p.ref === ref)!.location;
    let stops: SimStop[];
    if (runtime.plan) {
      const remaining = runtime.plan.stops.filter((s) => !runtime.visited.includes(s.placeId));
      stops = remaining.map((s) => ({ location: at(s.placeId), dwellS: 25 }));
      if (runtime.anchor) stops.push({ location: runtime.anchor.location, dwellS: 5 });
    } else if (selected) {
      // Esplorazione: si cammina verso il luogo selezionato...
      stops = [{ location: at(selected), dwellS: 40 }];
    } else {
      // ...oppure verso i luoghi più vicini non ancora ascoltati, uno dopo l'altro.
      const unheard = content.places.filter((p) => !runtime.wasNarrated(p.ref));
      stops = [];
      let here = from;
      for (let i = 0; i < 4 && unheard.length > 0; i++) {
        unheard.sort((a, b) => distanceM(here, a.location) - distanceM(here, b.location));
        const p = unheard.shift()!;
        stops.push({ location: p.location, dwellS: 30 });
        here = p.location;
      }
    }
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

  const startGps = () => {
    if (gpsWatchRef.current !== null) return;
    if (!("geolocation" in navigator)) {
      setGpsError("unavailable");
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
          setGpsError("denied");
          stopGps();
        } else {
          setGpsError(err.code === 3 ? "timeout" : "no_signal");
        }
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20_000 },
    );
    setGps(true);
    void requestWakeLock();
  };
  const toggleGps = () => (gps ? stopGps() : startGps());

  // Lo schermo acceso va richiesto di nuovo quando l'app torna in primo piano.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now();
        return;
      }
      if (gpsWatchRef.current !== null) {
        wakeLockRef.current = null;
        void requestWakeLock();
        // In secondo piano il browser non dà posizioni: lo si dice, invece di fingere un tracciamento continuo.
        if (hiddenAtRef.current !== null && Date.now() - hiddenAtRef.current > BACKGROUND_NOTICE_MS) setPausedNotice(true);
      }
      hiddenAtRef.current = null;
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [requestWakeLock]);

  // Con il GPS acceso si ricontrolla ogni pochi secondi l'età dell'ultima posizione (segnale perso).
  useEffect(() => {
    if (!gps) return;
    const id = setInterval(rerender, 5000);
    return () => clearInterval(id);
  }, [gps, rerender]);

  // Tornando dai percorsi guidati la pagina si apre su di loro.
  useEffect(() => {
    if (screen === "setup" && itinerariesOpen) document.getElementById("guided")?.scrollIntoView({ block: "start" });
  }, [screen, itinerariesOpen]);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(id);
  }, [flash]);

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
            <strong>{savedTour.kind === "explore" ? t.resumeExplore : t.resumeTitle}: {savedTour.entry.name}</strong>
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
    const visitInProgress = runtimeRef.current?.content === content && runtimeRef.current.memory.visitedPlaces.length > 0;
    return (
      <main className="screen">
        <button className="link" onClick={() => setScreen("home")}>← {t.back}</button>
        <h1>{content.name}</h1>
        {content.fictional && <p className="notice">{t.fictionalNote}</p>}
        {content.preview && <p className="notice preview">{t.previewNote}</p>}

        {visitInProgress && (
          <div className="card resume">
            <span>{t.continueVisit(runtimeRef.current!.memory.visitedPlaces.length)}</span>
            <button className="link" onClick={() => { runtimeRef.current = null; clearSavedTour(); setSavedTour(null); rerender(); }}>
              {t.restart}
            </button>
          </div>
        )}

        <h2>{t.mode}</h2>
        <div className="row wrap">
          {(["ask", "auto", "silent"] as const).map((m) => (
            <button key={m} className={`chip ${mode === m ? "on" : ""}`} onClick={() => setMode(m)}>
              {t.modes[m]}
            </button>
          ))}
        </div>

        <section className="card mode-card primary">
          <h2>🧭 {t.exploreTitle}</h2>
          <p>{t.exploreHint}</p>
          <p className="muted small">{t.backgroundNote}</p>
          <button className="button primary big" onClick={startExploring}>{t.exploreStart}</button>
        </section>

        <section className={`card mode-card ${itinerariesOpen ? "primary" : ""}`} id="guided">
          <h2>🗺 {t.itinerariesTitle}</h2>
          <p className="muted small">{t.itinerariesHint}</p>
          <div className="stack">
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
            <button className={`chip ${routeRef === null ? "on" : ""}`} onClick={() => setRouteRef(null)}>
              {t.routeFree}
            </button>
          </div>
          {routeRef === null && <h3>{t.howLong}</h3>}
          {routeRef === null && (
            <div className="row wrap">
              {BUDGETS.map((b) => (
                <button key={b} className={`chip ${budget === b ? "on" : ""}`} onClick={() => setBudget(b)}>
                  {b} {t.minutes}
                </button>
              ))}
            </div>
          )}
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
          <button className="button primary big" onClick={startTour}>{t.startItinerary}</button>
        </section>

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
      </main>
    );
  }

  if (!runtime || !content) return null;
  const exploring = runtime.kind === "explore";
  // La prossima tappa non si mostra se è il luogo in cui ci si trova già.
  const nextStop = runtime.nextStop !== runtime.currentPlaceRef ? runtime.nextStop : null;
  const nextPlace = nextStop ? content.places.find((p) => p.ref === nextStop) : null;
  const anchorStatus = runtime.lastAnchorStatus;
  const anchorName = runtime.anchor ? runtime.name(runtime.anchor.id) : "";
  const status = gpsStatus({ watching: gps, simulating, error: gpsError, fix: runtime.lastFix, source: fixSource, now: Date.now() });
  const cardRef = selected ?? runtime.currentPlaceRef;
  const canAsk = askAvailable && online;
  const nearby = runtime.nearby(NEARBY_COUNT);
  const leave = () => {
    stopSimulation();
    stopGps();
    voiceRef.current?.stop();
    // Da un itinerario si torna con gli itinerari aperti: è lì che si era.
    if (!exploring) setItinerariesOpen(true);
    setScreen("setup");
  };
  const openItineraries = () => {
    setItinerariesOpen(true);
    leave();
  };

  const proposalCard = proposal && (
    <section className="card proposal" role="alert">
      <p>{t.arrivedAsk(proposal.name)}</p>
      <div className="row">
        <button className="button primary" onClick={() => { setProposal(null); handleEvents(runtime.acceptProposal(Date.now())); }}>{t.yes}</button>
        <button className="button" onClick={() => { runtime.declineProposal(Date.now()); setProposal(null); saveTour(); rerender(); }}>{t.no}</button>
      </div>
    </section>
  );

  const placeCard = cardRef ? (
    <PlaceCard
      content={content}
      placeRef={cardRef}
      base={bundleBase}
      fix={runtime.lastFix}
      isHere={cardRef === runtime.currentPlaceRef}
      heard={runtime.wasNarrated(cardRef)}
      canAsk={canAsk}
      t={t}
      onListen={() => listenTo(cardRef)}
      onAsk={() => { setSelected(cardRef); setAskFocus((n) => n + 1); }}
      onHere={() => arriveHere(cardRef)}
      {...(selected ? { onClose: () => setSelected(null) } : {})}
    />
  ) : exploring ? (
    <p className="muted small">{t.selectHint}</p>
  ) : null;

  const speaking = speech.state !== "idle";
  const nowPlaying = (
    <section className="card now-playing" aria-live="polite">
      <p className="eyebrow">{speaking ? t.listening : runtime.currentPlaceRef ? `${t.here}: ${runtime.name(runtime.currentPlaceRef)}` : " "}</p>
      {!exploring && runtime.currentPlaceRef && <PlacePhoto content={content} placeRef={runtime.currentPlaceRef} base={bundleBase} label={t.photo} />}
      <p className="now-text">{currentSegment?.text ?? (transcript.length === 0 ? (exploring ? t.nothingExplore : t.nothing) : transcript.at(-1)!.text)}</p>
      {!voiceRef.current && <p className="muted small">{t.noVoice}</p>}
      <div className="controls">
        <button className="button big" disabled={!speaking} onClick={() => voiceRef.current?.toggle()}>
          {speech.state === "paused" ? `▶ ${t.play}` : `❚❚ ${t.pause}`}
        </button>
        <button className="button" disabled={!speaking} onClick={() => voiceRef.current?.skip()}>⏭ {t.skip}</button>
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
      {!exploring && runtime.currentPlaceRef && !speaking && !proposal && (
        <button className="button" onClick={() => handleEvents(runtime.narrate(runtime.currentPlaceRef))}>{t.tellMe}</button>
      )}
    </section>
  );

  const map = (
    <MapView
      content={content}
      runtime={runtime}
      debug={debug}
      online={online}
      simulated={fixSource === "simulated"}
      t={t}
      selected={selected}
      onSelect={setSelected}
      tall={exploring}
    />
  );

  const ask = askAvailable && (
    <AskBox
      content={content}
      runtime={runtime}
      voice={voiceRef.current}
      online={online}
      t={t}
      selectedPlace={selected}
      fixSource={fixSource}
      focusKey={askFocus}
      debug={debug}
      webAvailable={webAvailable}
    />
  );

  const controls = (
    <section className="card row wrap">
      {!simulating ? (
        <button className="button" onClick={startSimulation} disabled={gps}>🚶 {t.simulate}</button>
      ) : (
        <button className="button" onClick={stopSimulation}>■ {t.stopSim}</button>
      )}
      {simulating && <span className="muted small">{t.simulating}</span>}
      {exploring ? (
        <button className="button" onClick={() => {
          const el = document.getElementById("guided-in-session") as HTMLDetailsElement | null;
          if (el) { el.open = true; el.scrollIntoView({ behavior: "smooth", block: "start" }); }
        }}>🗺 {t.openItineraries}</button>
      ) : (
        <button className="button" onClick={switchToExplore}>🧭 {t.switchToExplore}</button>
      )}
    </section>
  );

  return (
    <main className={`screen walk ${exploring ? "explore" : "tour"}`}>
      <header className="walk-header">
        <button className="link" onClick={leave}>← {t.back}</button>
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

      <GpsBar status={status} gps={gps} simulating={simulating} onToggle={toggleGps} t={t} />
      {pausedNotice && (
        <p className="notice" role="status">
          {t.pausedNotice}{" "}
          <button className="link" onClick={() => setPausedNotice(false)}>✕</button>
        </p>
      )}
      {flash && <p className="notice" role="status">{flash}</p>}
      {complete && <p className="notice success">{t.complete}</p>}
      {proposalCard}

      {exploring ? (
        <>
          {map}
          {placeCard}
          {(speaking || transcript.length > 0) && nowPlaying}
          <section className="card">
            <h2>{t.nearbyTitle}</h2>
            {nearby.length === 0 ? (
              <p className="muted small">{t.nearbyNoFix}</p>
            ) : (
              <ul className="nearby">
                {nearby.map((p) => (
                  <li key={p.ref} className={p.ref === cardRef ? "on" : ""}>
                    <button onClick={() => setSelected(p.ref)}>
                      <span>
                        {p.ref === runtime.currentPlaceRef ? "📍 " : ""}
                        {p.name}
                        {p.narrated && <span className="muted small"> · ✓ {t.heard}</span>}
                      </span>
                      <span className="dist">
                        {formatDistance(p.distanceM, content.locale)} {compass(p.bearingDeg, t.dirs)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {ask}
          <details className="card" id="guided-in-session">
            <summary><strong>🗺 {t.itinerariesTitle}</strong></summary>
            <p className="muted small">{t.itinerariesHint}</p>
            <div className="stack">
              {content.routes.map((r) => (
                <button key={r.ref} className="chip route" onClick={() => switchToRoute(r.ref)}>
                  <span>{r.name}</span>
                  <span className="muted small">
                    {r.durationMin} {t.minutes}
                    {r.difficulty && <> · {t.difficulty[r.difficulty]}</>}
                    {r.calibration === "draft" && <> · {t.routeDraft}</>}
                  </span>
                </button>
              ))}
            </div>
            <button className="link" onClick={openItineraries}>{t.moreOptions} →</button>
          </details>
        </>
      ) : (
        <>
          {nowPlaying}
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
          {map}
          {selected && placeCard}
          {ask}
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
        </>
      )}

      {controls}

      {debug && (
        <DebugPanel
          content={content}
          runtime={runtime}
          gpsError={gpsError ? gpsErrorText(gpsError, t) : null}
          fixSource={fixSource}
          online={online}
          offlineReady={offlineSupported() ? offline === "yes" : null}
          bundleHash={opened?.manifest.kbHash ?? null}
          serverKbHash={serverBundles?.find((b) => b.destination === content.destination && b.locale === content.locale)?.kbHash ?? null}
          askAvailable={askAvailable}
          webAvailable={webAvailable}
        />
      )}

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

function gpsErrorText(code: GpsErrorCode, t: UiText): string {
  return { denied: t.gpsDenied, unavailable: t.gpsUnavailable, timeout: t.gpsTimeout, no_signal: t.gpsNoSignal }[code];
}

/** Stato del segnale di posizione: una riga sempre visibile, con il pulsante per accendere o spegnere il GPS. */
function GpsBar({ status, gps, simulating, onToggle, t }: { status: GpsStatus; gps: boolean; simulating: boolean; onToggle: () => void; t: UiText }) {
  const text = (() => {
    switch (status.level) {
      case "ok":
        return t.gps.ok(status.accuracyM ?? 0);
      case "imprecise":
        return t.gps.imprecise(status.accuracyM ?? 0);
      case "stale":
        return t.gps.stale(status.ageS ?? 0);
      case "waiting":
        return t.gps.waiting;
      case "simulated":
        return t.gps.simulated;
      case "denied":
        return t.gpsDenied;
      case "unavailable":
        return t.gpsUnavailable;
      case "no_signal":
        return t.gpsNoSignal;
      default:
        return `${t.gps.off}. ${t.backgroundNote}`;
    }
  })();
  const alert = ["stale", "no_signal", "denied", "unavailable", "imprecise"].includes(status.level);
  return (
    <div className={`gps-bar ${status.level}`} role={alert ? "alert" : "status"}>
      <p>📍 {text}</p>
      {status.level !== "unavailable" && !simulating && (
        <button className={`button ${gps ? "" : "primary"}`} onClick={onToggle}>
          {gps ? t.gps.stop : t.gps.start}
        </button>
      )}
    </div>
  );
}
