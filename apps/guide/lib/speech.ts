"use client";

/**
 * Voce della guida con la sintesi vocale del dispositivo (Web Speech API).
 *
 * È il ripiego offline previsto dall'architettura: in produzione le unità avranno
 * audio pre-registrato nel bundle e questa classe resterà per i testi senza audio.
 * Integra la Media Session, così pausa e "avanti" funzionano da schermata di blocco
 * e auricolari dove il sistema lo consente.
 */

export interface SpeechItem {
  id: string;
  text: string;
  title: string;
}

export type SpeechState = "idle" | "speaking" | "paused";

export class GuideVoice {
  private queue: SpeechItem[] = [];
  private current: SpeechItem | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  /** Cresce a ogni stop: la fine di un segmento annullato non deve far partire la coda nuova. */
  private generation = 0;
  state: SpeechState = "idle";
  rate = 1;

  constructor(
    private readonly lang: string,
    private readonly onChange: (state: SpeechState, current: SpeechItem | null) => void,
  ) {
    this.setupMediaSession();
  }

  static available(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  enqueue(items: SpeechItem[]): void {
    this.queue.push(...items);
    if (this.state === "idle") this.next();
  }

  pause(): void {
    if (this.state !== "speaking") return;
    window.speechSynthesis.pause();
    this.set("paused");
  }

  resume(): void {
    if (this.state !== "paused") return;
    window.speechSynthesis.resume();
    this.set("speaking");
  }

  toggle(): void {
    if (this.state === "speaking") this.pause();
    else if (this.state === "paused") this.resume();
  }

  /** Salta al segmento successivo. */
  skip(): void {
    window.speechSynthesis.cancel();
    // onend del segmento annullato fa partire il successivo.
  }

  stop(): void {
    this.generation++;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.queue = [];
    this.current = null;
    if (GuideVoice.available()) window.speechSynthesis.cancel();
    this.set("idle");
  }

  setRate(rate: number): void {
    this.rate = rate;
  }

  private next(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    const item = this.queue.shift();
    this.current = item ?? null;
    if (!item || !GuideVoice.available()) {
      this.set("idle");
      return;
    }
    const utterance = new SpeechSynthesisUtterance(item.text);
    utterance.lang = this.lang;
    utterance.rate = this.rate;
    const voice = window.speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(this.lang.slice(0, 2)));
    if (voice) utterance.voice = voice;
    let finished = false;
    const generation = this.generation;
    const done = () => {
      if (finished || generation !== this.generation) return;
      finished = true;
      this.next();
    };
    utterance.onend = done;
    utterance.onerror = done;
    this.updateMediaSession(item);
    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      // Sintesi vocale non disponibile o rifiutata: il testo resta leggibile a schermo.
      return done();
    }
    this.set("speaking");
    // Alcuni browser a volte non emettono "end": si passa avanti dopo una durata stimata generosa.
    const words = item.text.split(/\s+/).length;
    const estimateMs = ((words / 2.5) * 1000) / this.rate;
    const armWatchdog = () => {
      this.watchdog = setTimeout(() => {
        if (this.state === "paused") return armWatchdog();
        window.speechSynthesis.cancel();
        done();
      }, estimateMs * 1.6 + 3000);
    };
    armWatchdog();
  }

  private set(state: SpeechState): void {
    this.state = state;
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = state === "speaking" ? "playing" : state === "paused" ? "paused" : "none";
    this.onChange(state, this.current);
  }

  private setupMediaSession(): void {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("play", () => this.resume());
    navigator.mediaSession.setActionHandler("pause", () => this.pause());
    navigator.mediaSession.setActionHandler("nexttrack", () => this.skip());
  }

  private updateMediaSession(item: SpeechItem): void {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: item.title, artist: "AI Guide" });
  }
}
