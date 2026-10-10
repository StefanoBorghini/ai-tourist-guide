"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { verifyBundle, type BundleContent, type BundleManifest } from "@guide/bundle/client";
import { bearingDeg, distanceM, type Fix, type LngLat } from "@guide/context-engine";
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
import { Icon } from "./Icon";
import { PlaceCard, PlacePhoto, PlaceThumb, placeMedia, thumbSrc } from "./PlaceCard";

interface BundleEntry {
  destination: string;
  name: string;
  locale: string;
  fictional: boolean;
  /** Bundle di anteprima: territorio con contenuti ancora in revisione. */
  preview?: boolean;
  manifest: string;
  /** Copertina per la pagina iniziale (immagine, video facoltativo, testo alternativo, credito). */
  cover?: { image: string; video?: string; alt: string; credit?: string };
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
  const [speech, setSpeech] = useState<{ state: SpeechState; currentId: string | null; title?: string }>({ state: "idle", currentId: null });
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
  // La lingua scelta nella pagina iniziale vale per l'interfaccia e per il territorio che si apre.
  const [uiLocale, setUiLocale] = useState<"it" | "en">("en");
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("guide-lang");
    } catch {
      // memoria non disponibile
    }
    setUiLocale(saved === "it" || saved === "en" ? saved : navigator.language.startsWith("it") ? "it" : "en");
  }, []);
  const chooseLocale = (l: "it" | "en") => {
    setUiLocale(l);
    try {
      localStorage.setItem("guide-lang", l);
    } catch {
      // memoria non disponibile
    }
  };
  // Nella pagina iniziale vale la lingua scelta; dentro un territorio, quella del suo bundle.
  const locale = screen === "home" ? uiLocale : (content?.locale ?? uiLocale);
  const [view, setView] = useState<"map" | "list">("map");
  const [openRoute, setOpenRoute] = useState<string | null>(null);
  // Il video ambientale parte solo se il dispositivo non chiede movimento ridotto o risparmio dati.
  const [allowVideo, setAllowVideo] = useState(false);
  useEffect(() => {
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    setAllowVideo(!saveData && !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);
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
          setSpeech({ state, currentId: current?.id ?? null, ...(current?.title ? { title: current.title } : {}) });
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

  /** Avvia un percorso curato (ref) o su misura (null). */
  const startTour = (chosen: string | null = routeRef) => {
    if (!content) return;
    setRouteRef(chosen);
    const now = Date.now();
    const anchor = content.anchors[0];
    const route = chosen ? content.routes.find((r) => r.ref === chosen) : undefined;
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

  const brand = (
    <span className="brand">
      {/* eslint-disable-next-line @next/next/no-img-element -- marchio statico */}
      <img src="/brand/mark-white.png" alt="PV" width={47} height={22} />
      <span className="brand-sep" aria-hidden="true" />
      <span className="brand-name">AI Guide</span>
    </span>
  );
  const languageSwitch = (
    <div className="segmented on-photo" role="group" aria-label={t.language}>
      {(["it", "en"] as const).map((l) => (
        <button key={l} aria-pressed={uiLocale === l} onClick={() => chooseLocale(l)} lang={l}>
          {l === "it" ? "Italiano" : "English"}
        </button>
      ))}
    </div>
  );

  if (screen === "home") {
    const byDestination = new Map<string, BundleEntry[]>();
    for (const e of entries) byDestination.set(e.destination, [...(byDestination.get(e.destination) ?? []), e]);
    const groups = [...byDestination.values()];
    const pick = (group: BundleEntry[]) => group.find((e) => e.locale === uiLocale) ?? group[0]!;
    const real = groups.filter((g) => !g[0]!.fictional).map(pick);
    const demo = groups.filter((g) => g[0]!.fictional).map(pick);
    const featured = real.find((e) => e.cover) ?? real[0] ?? demo[0];
    const cover = featured?.cover;
    const languages = (destination: string) => (byDestination.get(destination) ?? []).map((e) => (e.locale === "it" ? "Italiano" : "English")).join(" · ");
    return (
      <main className="home">
        <section className="hero">
          {cover && (
            <div className="hero-media">
              {/* eslint-disable-next-line @next/next/no-img-element -- copertina statica del bundle */}
              <img className="ken" src={cover.image} alt={cover.alt} fetchPriority="high" />
              {cover.video && allowVideo && online && <video src={cover.video} poster={cover.image} autoPlay muted loop playsInline preload="auto" aria-hidden="true" />}
            </div>
          )}
          <header className="hero-top">
            {brand}
            {languageSwitch}
          </header>
          <div className="hero-copy">
            {featured && (
              <span className="hero-place">
                <Icon name="pin" size={16} /> {featured.name}
              </span>
            )}
            <h1>{t.heroTitle}</h1>
            <p className="lede">{t.heroLede}</p>
            {featured && (
              <div className="hero-cta">
                <button className="button primary xl" onClick={() => openBundle(featured)}>
                  {t.exploreStart} <Icon name="forward" />
                </button>
                {featured.preview && <span className="badge on-photo">{t.previewBadge}</span>}
              </div>
            )}
            {cover?.credit && <p className="hero-credit">{t.photo}: {cover.credit}</p>}
          </div>
        </section>

        <div className="home-body">
          {!online && (
            <p className="notice">
              <Icon name="wifiOff" /> {t.offlineNow}
            </p>
          )}
          {error && <p className="notice gps-error">{online ? error : t.offlineNoBundle}</p>}
          {savedTour && (
            <div className="resume">
              <div>
                <strong>{savedTour.kind === "explore" ? t.resumeExplore : t.resumeTitle}: {savedTour.entry.name}</strong>
                <span className="small" style={{ display: "block" }}>
                  {t.resumeSaved} {clock(savedTour.savedAt, locale)} · {savedTour.state.memory.visitedPlaces.length} {t.resumeVisited}
                </span>
              </div>
              <div className="row">
                <button className="button primary" onClick={() => void resumeTour(savedTour)}>{t.resume}</button>
                <button className="button ghost" onClick={() => { clearSavedTour(); setSavedTour(null); }}>{t.resumeDiscard}</button>
              </div>
            </div>
          )}

          {real.length > 0 && (
            <>
              <div className="section-head">
                <h2>{t.destinations}</h2>
              </div>
              <div className="dest-grid">
                {real.map((e) => (
                  <article key={e.destination} className="dest-card">
                    {/* eslint-disable-next-line @next/next/no-img-element -- copertina statica del bundle */}
                    {e.cover && <img src={e.cover.image} alt={e.cover.alt} loading="lazy" />}
                    <div className="dest-card-body">
                      <h3>{e.name}</h3>
                      <p className="meta">
                        <Icon name="globe" size={16} /> {t.languagesAvailable}: {languages(e.destination)}
                        {e.preview && <span className="badge on-photo">{t.previewBadge}</span>}
                      </p>
                      <button className="button primary" onClick={() => openBundle(e)}>
                        {t.exploreDestination(e.name)} <Icon name="forward" />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}

          {demo.length > 0 && (
            <section className="section">
              <div className="section-intro">
                <h3>{t.demoTerritories}</h3>
                <p className="muted small">{t.demoNote}</p>
              </div>
              <div className="demo-list">
                {demo.map((e) => (
                  <button key={e.destination} className="demo-item" onClick={() => openBundle(e)}>
                    <span>
                      <strong>{e.name}</strong>
                      <span className="muted small" style={{ display: "block" }}>{t.fictional} · {languages(e.destination)}</span>
                    </span>
                    <Icon name="forward" />
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
        <footer className="home-foot muted small">AI Guide{cover?.credit ? ` · ${t.photo}: ${cover.credit}` : ""}</footer>
      </main>
    );
  }

  /** Copertina della destinazione aperta: quella dell'indice, oppure la prima immagine del bundle. */
  const destinationCover = (c: BundleContent): { src: string; alt: string } | null => {
    const fromIndex = openedEntryRef.current?.cover;
    if (fromIndex) return { src: fromIndex.image, alt: fromIndex.alt };
    const first = c.media.find((m) => m.cover) ?? c.media[0];
    const src = thumbSrc(first, bundleBase);
    return first && src ? { src, alt: first.alt } : null;
  };
  /**
   * Copertina di un percorso: una foto delle sue tappe (prima le foto, poi i fotogrammi dei video).
   * Percorsi diversi ruotano tra le foto disponibili, così le schede non si ripetono.
   */
  const routeCover = (c: BundleContent, stops: string[]) => {
    const pool = [...new Set(stops.flatMap((ref) => placeMedia(c, ref)))].sort((a, b) => Number(a.kind === "video") - Number(b.kind === "video"));
    const i = Math.max(0, c.routes.findIndex((r) => r.stops.map((s) => s.place).join() === stops.join()));
    return thumbSrc(pool[i % Math.max(1, pool.length)], bundleBase);
  };
  const placeName = (c: BundleContent, ref: string) => c.places.find((p) => p.ref === ref)?.name ?? ref;

  if (screen === "setup" && content) {
    const anchor = content.anchors[0];
    const visitInProgress = runtimeRef.current?.content === content && runtimeRef.current.memory.visitedPlaces.length > 0;
    const heroCover = destinationCover(content);
    return (
      <main className="hub">
        <section className="hub-hero">
          {/* eslint-disable-next-line @next/next/no-img-element -- copertina statica del bundle */}
          {heroCover && <img src={heroCover.src} alt={heroCover.alt} />}
          <div className="hero-top">
            <button className="back-btn" onClick={() => setScreen("home")}>
              <Icon name="back" /> {t.back}
            </button>
            {brand}
          </div>
          <div className="hub-title">
            <p className="eyebrow" style={{ color: "rgba(255,255,255,.8)" }}>{t.howToVisit}</p>
            <h1>{content.name}</h1>
            <div className="row wrap">
              {content.preview && <span className="badge on-photo">{t.previewBadge}</span>}
              {content.fictional && <span className="badge on-photo">{t.fictional}</span>}
            </div>
          </div>
        </section>

        <div className="hub-body">
          {visitInProgress && (
            <div className="resume light">
              <span>{t.continueVisit(runtimeRef.current!.memory.visitedPlaces.length)}</span>
              <div className="row">
                <button className="button ghost" onClick={() => { runtimeRef.current = null; clearSavedTour(); setSavedTour(null); rerender(); }}>
                  {t.restart}
                </button>
              </div>
            </div>
          )}

          <div className="hub-grid">
            <div className="stack" style={{ gap: 22 }}>
              <section className="mode-explore">
                <h2>{t.exploreTitle}</h2>
                <p className="muted">{t.exploreHint}</p>
                <ul className="feature-list">
                  {t.exploreFeatures.map((f, i) => (
                    <li key={f}>
                      <Icon name={(["map", "volume", "chat"] as const)[i]!} /> {f}
                    </li>
                  ))}
                </ul>
                <button className="button primary xl block" onClick={startExploring}>
                  {t.exploreStart} <Icon name="forward" />
                </button>
                <p className="muted small">{t.backgroundNote}</p>
              </section>

              <section className="card prefs">
                <h3>{t.preferences}</h3>
                <p className="muted small">{t.mode}</p>
                <div className="segmented wide" role="group" aria-label={t.mode}>
                  {(["ask", "auto", "silent"] as const).map((m) => (
                    <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>
                      {t.modes[m]}
                    </button>
                  ))}
                </div>
                <label className="check">
                  <input type="checkbox" checked={avoidStairs} onChange={(e) => setAvoidStairs(e.target.checked)} />
                  {t.avoidStairs}
                </label>
                {offlineSupported() && opened && (
                  <div className="offline-box">
                    {offline === "yes" ? (
                      <p className="ok"><Icon name="check" /> {t.offlineReady}</p>
                    ) : (
                      <>
                        <button className="button quiet" disabled={offline === "downloading" || !online} onClick={saveOffline}>
                          <Icon name="download" /> {t.offlineDownload} ({Math.ceil(opened.manifest.totalBytes / 1024)} KB)
                        </button>
                        {offline === "downloading" && <p className="muted small">{Math.round(progress * 100)}%</p>}
                        {offline === "error" && <p className="error small">{t.offlineError}</p>}
                        <p className="muted small">{t.offlineHint}</p>
                      </>
                    )}
                  </div>
                )}
              </section>
              {content.preview && (
                <p className="notice preview">
                  <Icon name="info" /> {t.previewNote}
                </p>
              )}
              {content.fictional && (
                <p className="notice">
                  <Icon name="info" /> {t.fictionalNote}
                </p>
              )}
              {content.safetyNotes.map((n) => (
                <p key={n.id} className="notice">
                  <Icon name="info" /> {n.text}
                </p>
              ))}
            </div>

            <section className="section" id="guided">
              <div className="section-intro">
                <h2>{t.itinerariesTitle}</h2>
                <p className="muted small">{t.itinerariesHint}</p>
              </div>
              {content.routes.map((r) => {
                const open = openRoute === r.ref || (itinerariesOpen && openRoute === null && routeRef === r.ref);
                const stops = r.stops.map((s) => s.place);
                const cover = routeCover(content, stops);
                return (
                  <article key={r.ref} className={`route-card ${open ? "open" : ""}`}>
                    <button className="route-head" aria-expanded={open} onClick={() => setOpenRoute(open ? "" : r.ref)}>
                      <span className="route-cover">
                        {/* eslint-disable-next-line @next/next/no-img-element -- foto della prima tappa */}
                        {cover ? <img src={cover} alt="" loading="lazy" /> : <Icon name="route" size={28} />}
                      </span>
                      <span>
                        <span className="route-title">{r.name}</span>
                        <span className="meta-line">
                          <span><Icon name="clock" size={15} /> {r.durationMin} {t.minutes}</span>
                          <span><Icon name="pin" size={15} /> {t.stopsCount(stops.length)}</span>
                          {r.difficulty && <span><Icon name="walk" size={15} /> {t.difficulty[r.difficulty]}</span>}
                          {r.elevationGainM !== undefined && <span><Icon name="steps" size={15} /> +{r.elevationGainM} m</span>}
                        </span>
                        {r.calibration === "draft" && <span className="muted small" style={{ display: "block", marginTop: 4 }}>{t.routeDraft}</span>}
                      </span>
                      <Icon name="forward" className="chev" />
                    </button>
                    {open && (
                      <div className="route-body">
                        <p className="eyebrow">{t.routeStops}</p>
                        <ol className="stops-strip">
                          {stops.map((ref, i) => (
                            <li key={ref}>
                              <span className="stop-num">{i + 1}</span>
                              <span className="stop-name">{placeName(content, ref)}</span>
                            </li>
                          ))}
                        </ol>
                        <button className="button primary big block" onClick={() => startTour(r.ref)}>
                          {t.startItinerary} <Icon name="forward" />
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}

              <article className={`route-card ${openRoute === "custom" ? "open" : ""}`}>
                <button className="route-head" aria-expanded={openRoute === "custom"} onClick={() => setOpenRoute(openRoute === "custom" ? "" : "custom")}>
                  <span className="route-cover"><Icon name="sparkle" size={30} /></span>
                  <span>
                    <span className="route-title">{t.customRoute}</span>
                    <span className="meta-line"><span>{t.customRouteHint}</span></span>
                  </span>
                  <Icon name="forward" className="chev" />
                </button>
                {openRoute === "custom" && (
                  <div className="route-body custom-route">
                    <p className="eyebrow">{t.howLong}</p>
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
                    <button className="button primary big block" onClick={() => startTour(null)}>
                      {t.startItinerary} <Icon name="forward" />
                    </button>
                  </div>
                )}
              </article>
            </section>
          </div>
        </div>
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
  const tourRoute = !exploring && tourOptionsRef.current?.route ? content.routes.find((r) => r.ref === tourOptionsRef.current!.route) : undefined;
  const planStops = runtime.plan?.stops.map((s) => s.placeId) ?? [];
  const doneCount = planStops.filter((ref) => runtime.visited.includes(ref)).length;
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
  const choosePlace = (ref: string) => {
    setSelected(ref);
    // Su telefono la scheda è sotto la mappa: la si porta in vista.
    requestAnimationFrame(() => document.querySelector(".place-card")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };

  const proposalCard = proposal && (
    <section className="proposal" role="alert">
      <PlaceThumb content={content} placeRef={proposal.placeRef} base={bundleBase} name={proposal.name} className="thumb" />
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
    <p className="notice">
      <Icon name="pin" /> {t.selectHint}
    </p>
  ) : null;

  const speaking = speech.state !== "idle";
  const nowPlaying = (
    <section className="card now-playing" aria-live="polite">
      <p className="eyebrow">{speaking ? t.listening : runtime.currentPlaceRef ? `${t.here}: ${runtime.name(runtime.currentPlaceRef)}` : " "}</p>
      {!exploring && runtime.currentPlaceRef && <PlacePhoto content={content} placeRef={runtime.currentPlaceRef} base={bundleBase} label={t.photo} />}
      <p className="now-text">{currentSegment?.text ?? (transcript.length === 0 ? (exploring ? t.nothingExplore : t.nothing) : transcript.at(-1)!.text)}</p>
      {!voiceRef.current && <p className="muted small">{t.noVoice}</p>}
      <div className="controls">
        <button className="button primary big" disabled={!speaking} onClick={() => voiceRef.current?.toggle()}>
          {speech.state === "paused" ? <><Icon name="play" /> {t.play}</> : <><Icon name="pause" /> {t.pause}</>}
        </button>
        <button className="button" disabled={!speaking} onClick={() => voiceRef.current?.skip()}><Icon name="skip" /> {t.skip}</button>
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
        <button className="button" onClick={() => handleEvents(runtime.narrate(runtime.currentPlaceRef))}>
          <Icon name="volume" /> {t.tellMe}
        </button>
      )}
    </section>
  );

  // Lettore sempre a portata di pollice mentre la guida parla.
  const player = speaking && (
    <div className={`player ${speech.state === "paused" ? "paused" : ""}`} role="region" aria-label={t.nowPlaying}>
      <span className="eq" aria-hidden="true"><i /><i /><i /></span>
      <span className="what">
        <strong>{currentSegment ? runtime.name(currentSegment.placeRef) : (speech.title ?? t.nowPlaying)}</strong>
        <span>{t.nowPlaying}</span>
      </span>
      <span className="actions">
        <button className="round-btn main" onClick={() => voiceRef.current?.toggle()} aria-label={speech.state === "paused" ? t.play : t.pause}>
          <Icon name={speech.state === "paused" ? "play" : "pause"} />
        </button>
        <button className="round-btn" onClick={() => voiceRef.current?.skip()} aria-label={t.skip}>
          <Icon name="skip" />
        </button>
      </span>
    </div>
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
      onSelect={(ref) => (ref ? choosePlace(ref) : setSelected(null))}
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
      base={bundleBase}
    />
  );

  const tools = (
    <section className="tools">
      <p className="eyebrow">{t.tools}</p>
      {!simulating ? (
        <button className="button quiet" onClick={startSimulation} disabled={gps}><Icon name="walk" /> {t.simulate}</button>
      ) : (
        <button className="button quiet" onClick={stopSimulation}>■ {t.stopSim}</button>
      )}
      {simulating && <span className="muted small">{t.simulating}</span>}
    </section>
  );

  // Tutti i luoghi, i più vicini prima quando la posizione è nota.
  const fixHere = runtime.lastFix?.location;
  const allPlaces = content.places
    .map((p) => ({ p, d: fixHere ? distanceM(fixHere, p.location) : null }))
    .sort((a, b) => (a.d !== null && b.d !== null ? a.d - b.d : 0));

  const exploreMain = (
    <>
      <div className="view-switch">
        <div className="segmented" role="group" aria-label={t.allPlaces}>
          <button aria-pressed={view === "map"} onClick={() => setView("map")}><Icon name="map" size={18} /> {t.viewMap}</button>
          <button aria-pressed={view === "list"} onClick={() => setView("list")}><Icon name="list" size={18} /> {t.viewList}</button>
        </div>
        <span className="muted small">{t.placesCount(content.places.length)}</span>
      </div>
      {view === "map" ? (
        <>
          {map}
          <section className="section" aria-label={t.nearbyTitle}>
            <h3>{t.nearbyTitle}</h3>
            {nearby.length === 0 ? (
              <p className="muted small">{t.nearbyNoFix}</p>
            ) : (
              <div className="carousel nearby">
                {nearby.map((p) => (
                  <button key={p.ref} className={`tile ${p.ref === cardRef ? "on" : ""}`} onClick={() => choosePlace(p.ref)}>
                    <PlaceThumb content={content} placeRef={p.ref} base={bundleBase} name={p.name} className="tile-img" />
                    <span className="tile-body">
                      <span className="tile-name">{p.ref === runtime.currentPlaceRef ? "📍 " : ""}{p.name}</span>
                      <span className="dist">
                        {formatDistance(p.distanceM, content.locale)} {compass(p.bearingDeg, t.dirs)}
                        {p.narrated && <span className="good">· ✓ {t.heard}</span>}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      ) : (
        <ul className="places">
          {allPlaces.map(({ p, d }) => (
            <li key={p.ref}>
              <button className={`place-row ${p.ref === cardRef ? "on" : ""}`} onClick={() => choosePlace(p.ref)}>
                <PlaceThumb content={content} placeRef={p.ref} base={bundleBase} name={p.name} className="thumb" />
                <span>
                  <span className="name">{p.name}</span>
                  {p.short && <span className="short">{p.short}</span>}
                </span>
                <span className="dist">
                  {d !== null && fixHere ? <>{formatDistance(d, content.locale)}<br />{compass(bearingDeg(fixHere, p.location), t.dirs)}</> : null}
                  {runtime.wasNarrated(p.ref) && <span className="heard" style={{ display: "block" }}>✓</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  const tourProgress = (
    <section className="card tour-progress">
      <div>
        <p className="eyebrow">{tourRoute?.name ?? t.itinerariesTitle}</p>
        {planStops.length > 0 && <h3>{t.progress(Math.min(doneCount + 1, planStops.length), planStops.length)}</h3>}
      </div>
      {planStops.length > 0 && (
        <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={planStops.length} aria-valuenow={doneCount}>
          <span style={{ width: `${(100 * doneCount) / planStops.length}%` }} />
        </div>
      )}
      {nextPlace && (
        <div className="next-stop">
          <PlaceThumb content={content} placeRef={nextPlace.ref} base={bundleBase} name={nextPlace.name} className="thumb" />
          <div>
            <span className="muted small">{t.next}</span>
            <strong>{nextPlace.name}</strong>
          </div>
        </div>
      )}
      {runtime.nextStop && (
        <div className="manual">
          <p className="muted small">{t.manualHint}</p>
          <div className="row wrap">
            <button className="button" onClick={() => arriveHere(runtime.nextStop!)}><Icon name="pin" /> {t.imHere}: {runtime.name(runtime.nextStop)}</button>
            {runtime.routeStops && (
              <button className="button quiet" onClick={() => skipStop(runtime.nextStop!)}><Icon name="skip" /> {t.skipStop}</button>
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
  );

  const planCard = (
    <section className="card">
      <h3>{t.plan}</h3>
      <ol className="stops-strip">
        {runtime.plan?.stops.map((s, i) => {
          const done = runtime.visited.includes(s.placeId);
          const current = !done && s.placeId === runtime.nextStop;
          return (
            <li key={s.placeId} className={done ? "done" : current ? "current" : ""}>
              <span className="stop-num">{done ? <Icon name="check" size={16} /> : i + 1}</span>
              <span className="stop-name">
                {runtime.name(s.placeId)} {done && <span className="muted small">· {t.visited}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );

  const itinerariesInSession = (
    <details className="card" id="guided-in-session">
      <summary><Icon name="route" /> {t.itinerariesTitle}</summary>
      <p className="muted small">{t.itinerariesHint}</p>
      <div className="stack">
        {content.routes.map((r) => (
          <button key={r.ref} className="place-row" onClick={() => switchToRoute(r.ref)}>
            <span className="thumb">
              {/* eslint-disable-next-line @next/next/no-img-element -- foto della prima tappa */}
              {routeCover(content, r.stops.map((s) => s.place)) ? <img src={routeCover(content, r.stops.map((s) => s.place))!} alt="" loading="lazy" /> : <Icon name="route" />}
            </span>
            <span>
              <span className="name">{r.name}</span>
              <span className="short">
                {r.durationMin} {t.minutes} · {t.stopsCount(r.stops.length)}
                {r.difficulty && <> · {t.difficulty[r.difficulty]}</>}
                {r.calibration === "draft" && <> · {t.routeDraft}</>}
              </span>
            </span>
            <Icon name="forward" />
          </button>
        ))}
      </div>
      <button className="link" onClick={openItineraries}>{t.moreOptions} <Icon name="forward" size={16} /></button>
    </details>
  );

  return (
    <main className={`walk ${exploring ? "explore" : "tour"}`}>
      <header className="topbar">
        <button className="round-btn" onClick={leave} aria-label={t.back}><Icon name="back" /></button>
        <div style={{ minWidth: 0 }}>
          <div className="title">{content.name}</div>
          <span className="sub">{exploring ? t.exploreTitle : (tourRoute?.name ?? t.itinerariesTitle)}</span>
        </div>
        <span className="spacer" />
        {!online && <span className="badge offline"><Icon name="wifiOff" size={14} /> {t.offlineBadge}</span>}
        {content.preview && <span className="badge preview">{t.previewBadge}</span>}
        {content.fictional && <span className="badge">{t.fictional}</span>}
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
        <p className="notice toast" role="status">
          <Icon name="info" /> {t.pausedNotice}
          <button className="link" onClick={() => setPausedNotice(false)} aria-label={t.close}><Icon name="close" size={18} /></button>
        </p>
      )}
      {flash && <p className="notice toast" role="status"><Icon name="info" /> {flash}</p>}
      {complete && <p className="notice success toast"><Icon name="check" /> {t.complete}</p>}
      {proposalCard}

      <div className="walk-grid">
        <div className="walk-main">{exploring ? exploreMain : map}</div>
        <div className="walk-side">
          {exploring ? (
            <>
              {placeCard}
              {(speaking || transcript.length > 0) && nowPlaying}
              {ask}
              {itinerariesInSession}
            </>
          ) : (
            <>
              {tourProgress}
              {nowPlaying}
              {selected && placeCard}
              {ask}
              {planCard}
              <button className="button quiet" onClick={switchToExplore}><Icon name="compass" /> {t.switchToExplore}</button>
            </>
          )}
          {tools}
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
        </div>
      </div>
      {player}
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
      <p>
        <span className="gps-dot" aria-hidden="true" />
        <span>📍 {text}</span>
      </p>
      {status.level !== "unavailable" && !simulating && (
        <button className={`button ${gps ? "quiet" : "primary"}`} onClick={onToggle}>
          {gps ? t.gps.stop : t.gps.start}
        </button>
      )}
    </div>
  );
}
