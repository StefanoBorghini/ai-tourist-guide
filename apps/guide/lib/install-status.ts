/**
 * Diario dell'installazione della PWA, per il pannello di prova (`?debug=1`).
 *
 * Chrome segnala tre momenti: offre l'installazione (`beforeinstallprompt`), la persona sceglie (accetta o rifiuta)
 * e l'installazione è completata (`appinstalled`). Su Android, tra la scelta e il completamento c'è il pacchetto
 * dell'app costruito da Google: se i permessi del telefono o l'indirizzo lo bloccano, il terzo momento non arriva.
 * Il diario resta nel telefono (localStorage), così si legge anche dopo aver chiuso e riaperto la pagina.
 */

export type InstallStep = "offered" | "accepted" | "dismissed" | "installed";
export interface InstallEntry {
  step: InstallStep;
  at: number;
}

const KEY = "guide-install-log";
const MAX = 20;

export function readInstallLog(): InstallEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? (raw as InstallEntry[]).filter((e) => e && typeof e.at === "number" && typeof e.step === "string") : [];
  } catch {
    return [];
  }
}

export function recordInstallStep(step: InstallStep, at = Date.now()): void {
  try {
    const log = readInstallLog();
    // «Offerta» arriva a ogni apertura: se ne tiene solo l'ultima di seguito.
    if (step === "offered" && log.at(-1)?.step === "offered") log.pop();
    log.push({ step, at });
    localStorage.setItem(KEY, JSON.stringify(log.slice(-MAX)));
  } catch {
    // Archiviazione non disponibile: il diario resta vuoto.
  }
}

/** Ascolta gli eventi del browser per tutta la vita della pagina; restituisce la funzione che smette. */
export function watchInstall(): () => void {
  const offered = () => recordInstallStep("offered");
  const installed = () => recordInstallStep("installed");
  window.addEventListener("beforeinstallprompt", offered);
  window.addEventListener("appinstalled", installed);
  return () => {
    window.removeEventListener("beforeinstallprompt", offered);
    window.removeEventListener("appinstalled", installed);
  };
}

export interface InstallSummary {
  /** Stato in una riga, in parole semplici. */
  line: string;
  /** Livello per il colore: tutto bene, da guardare, problema. */
  level: "good" | "warn" | "bad";
}

/**
 * Riassunto dell'installazione per il pannello di prova. Puro: riceve il diario, se la pagina è aperta come app
 * installata e una funzione per l'orario.
 */
export function installSummary(log: InstallEntry[], standalone: boolean, clock: (t: number) => string): InstallSummary {
  if (standalone) return { line: "aperta come app installata", level: "good" };
  const last = (step: InstallStep) => [...log].reverse().find((e) => e.step === step);
  const offered = last("offered");
  const accepted = last("accepted");
  const dismissed = last("dismissed");
  const installed = last("installed");
  if (installed && (!accepted || installed.at >= accepted.at)) {
    return { line: `installazione completata alle ${clock(installed.at)} (aprila dall'icona sulla schermata Home)`, level: "good" };
  }
  if (accepted) {
    return {
      line: `«Installa» accettato alle ${clock(accepted.at)}, ma Chrome non ha confermato l'installazione: controlla i permessi di Chrome sul telefono («Scorciatoie nella schermata Home») e che l'indirizzo non sia protetto`,
      level: "bad",
    };
  }
  if (dismissed && (!offered || dismissed.at >= offered.at)) return { line: `installazione rifiutata alle ${clock(dismissed.at)}`, level: "warn" };
  // Dal menu di Chrome (⋮ → «Installa app») la scelta non arriva alla pagina: conta solo se l'installazione si completa.
  if (offered) return { line: `Chrome offre l'installazione (ultima volta alle ${clock(offered.at)}); nessuna installazione completata finora`, level: "warn" };
  return { line: "il browser non ha offerto l'installazione in questa pagina (o è già installata, o il browser non la supporta)", level: "warn" };
}
