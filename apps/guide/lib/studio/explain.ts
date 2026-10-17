/**
 * Controllo di pubblicazione in parole semplici: i problemi del validatore, raggruppati per tipo, con una frase
 * comprensibile, cosa fare e la sezione dello Studio dove farlo. Puro (test in test/explain.test.ts).
 */
import type { ReadinessIssue } from "./readiness";

/** Sezioni dello Studio a cui rimanda una correzione (stessi nomi delle schede). */
export type FixTab = "panoramica" | "luoghi" | "fonti" | "affermazioni" | "racconti" | "percorsi" | "media" | "vendita";

export interface ExplainedGroup {
  code: string;
  level: "error" | "warning";
  /** Quante volte compare. */
  count: number;
  /** Frase breve, già con il numero. */
  title: string;
  /** Cosa fare per correggere. */
  todo: string;
  fix?: { tab: FixTab; label: string };
  /** Righe tecniche originali, per chi vuole il dettaglio. */
  details: string[];
}

interface Rule {
  title: (n: number) => string;
  todo: string;
  tab?: FixTab;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

export const TAB_LABELS: Record<FixTab, string> = {
  panoramica: "Apri la panoramica",
  luoghi: "Apri i luoghi",
  fonti: "Apri le fonti",
  affermazioni: "Apri i fatti",
  racconti: "Apri i racconti",
  percorsi: "Apri i percorsi",
  media: "Apri le foto",
  vendita: "Apri la vendita",
};

const RULES: Record<string, Rule> = {
  SOURCE_NOT_FOUND: {
    title: (n) => `${plural(n, "Un fatto cita", "fatti citano")} una fonte che non c'è (o non è raggiungibile)`,
    todo: "Ricrea la fonte con lo stesso codice, oppure apri il fatto e scegli un'altra fonte.",
    tab: "fonti",
  },
  FICTIONAL_SOURCE: { title: (n) => `${plural(n, "Un fatto cita", "fatti citano")} una fonte di prova`, todo: "Sostituisci la fonte con una reale.", tab: "affermazioni" },
  EVIDENCE_REQUIRED: { title: (n) => `${plural(n, "Un fatto è", "fatti sono")} senza fonte`, todo: "Aggiungi a ogni fatto almeno una fonte.", tab: "affermazioni" },
  EVIDENCE_INFERRED: { title: (n) => `${plural(n, "Un fatto è", "fatti sono")} solo dedotti dalle fonti`, todo: "Controlla che la deduzione sia corretta, o cita una fonte esplicita.", tab: "affermazioni" },
  VERIFIER_REQUIRED: { title: (n) => `${plural(n, "Un fatto verificato non dice", "fatti verificati non dicono")} chi l'ha verificato`, todo: "Riapri la verifica e indica il revisore.", tab: "affermazioni" },
  FOUR_EYES: { title: (n) => `${plural(n, "Un fatto è stato verificato", "fatti sono stati verificati")} da chi l'ha scritto`, todo: "Serve la verifica di una seconda persona.", tab: "affermazioni" },
  CERTAINTY_REQUIRED: { title: (n) => `${plural(n, "Un fatto non indica", "fatti non indicano")} quanto è certo`, todo: "Indica il grado di certezza.", tab: "affermazioni" },
  DISPUTE_REQUIRED: { title: (n) => `${plural(n, "Un fatto discusso non riporta", "fatti discussi non riportano")} le versioni in disaccordo`, todo: "Aggiungi le versioni alternative con le loro fonti.", tab: "affermazioni" },
  DISPUTE_SINGLE: { title: (n) => `${plural(n, "Un fatto discusso ha", "fatti discussi hanno")} una sola versione`, todo: "Aggiungi almeno un'altra versione, o togli «discusso».", tab: "affermazioni" },
  UNIT_ASSERTION_UNKNOWN: { title: (n) => `${plural(n, "Un racconto usa", "racconti usano")} un fatto che non esiste più`, todo: "Apri il racconto e collega fatti esistenti.", tab: "racconti" },
  UNIT_ASSERTION_NOT_NARRATABLE: { title: (n) => `${plural(n, "Un racconto usa", "racconti usano")} fatti non ancora verificati`, todo: "Verifica i fatti collegati, o toglili dal racconto.", tab: "affermazioni" },
  UNIT_LOCALE: { title: (n) => `${plural(n, "Un racconto è", "racconti sono")} in una lingua non prevista`, todo: "Controlla la lingua del racconto e le lingue del territorio.", tab: "racconti" },
  UNIT_DURATION: { title: (n) => `${plural(n, "Un racconto ha", "racconti hanno")} una durata fuori misura`, todo: "Accorcia o allunga il testo.", tab: "racconti" },
  CONCEPT_NEVER_INTRODUCED: { title: (n) => `${plural(n, "Un racconto richiama", "racconti richiamano")} qualcosa mai presentato prima`, todo: "Aggiungi il racconto che lo introduce, o togli il richiamo.", tab: "racconti" },
  NO_NARRATION: { title: () => "Nessun racconto pronto per l'app", todo: "Servono racconti collegati a fatti verificati (nei territori in anteprima bastano fatti in revisione).", tab: "racconti" },
  NO_PLACES: { title: () => "Il territorio non ha ancora luoghi", todo: "Aggiungi almeno un luogo.", tab: "luoghi" },
  FICTIONAL: { title: () => "È un territorio di prova: non si pubblica", todo: "I territori fittizi servono solo per i test.", tab: "panoramica" },
  MEDIA_NOT_IN_STORAGE: { title: (n) => `${plural(n, "Una foto è registrata", "foto sono registrate")} ma il file non è caricato`, todo: "Carica il file, o usa «Copia i file dal repository».", tab: "media" },
  MEDIA_ATTRIBUTION: { title: (n) => `${plural(n, "Una foto non ha", "foto non hanno")} autore o licenza`, todo: "Completa autore, fonte e licenza.", tab: "media" },
  MEDIA_ORIGIN: { title: (n) => `${plural(n, "Una foto non dice", "foto non dicono")} da dove viene`, todo: "Indica la provenienza.", tab: "media" },
  MEDIA_ALT: { title: (n) => `${plural(n, "Una foto è", "foto sono")} senza descrizione`, todo: "Scrivi una descrizione breve (serve a chi non vede).", tab: "media" },
  MEDIA_NON_COMMERCIAL: { title: (n) => `${plural(n, "Una foto ha", "foto hanno")} una licenza non commerciale`, todo: "Usa foto con licenza adatta a un'app a pagamento.", tab: "media" },
  MEDIA_NOT_USABLE: { title: (n) => `${plural(n, "Una foto non è", "foto non sono")} utilizzabili`, todo: "Controlla licenza e stato della foto.", tab: "media" },
  MEDIA_FILE_REUSED: { title: (n) => `${plural(n, "Un file è usato", "file sono usati")} da più foto`, todo: "Ogni foto deve avere il suo file.", tab: "media" },
  COORDINATES_NOT_VERIFIED: { title: (n) => `${plural(n, "La posizione di un luogo", "posizioni dei luoghi")} da verificare sul posto`, todo: "Verifica la posizione sul campo prima della produzione.", tab: "luoghi" },
  COORDINATES_PRELIMINARY: { title: (n) => `${plural(n, "Un luogo ha", "luoghi hanno")} una posizione provvisoria`, todo: "Verifica la posizione sulla mappa e poi sul posto.", tab: "luoghi" },
  COORDINATES_NEED_REVIEW: { title: (n) => `${plural(n, "Un luogo ha", "luoghi hanno")} una posizione segnalata come dubbia`, todo: "Ricontrolla la posizione sul posto.", tab: "luoghi" },
  COORDINATES_MAP_ONLY: { title: (n) => `${plural(n, "Un luogo è verificato", "luoghi sono verificati")} solo sulla mappa`, todo: "Per la produzione serve la verifica sul posto.", tab: "luoghi" },
  GEOFENCE_MISSING: { title: (n) => `${plural(n, "Un luogo non ha", "luoghi non hanno")} l'area di arrivo`, todo: "Indica il raggio in cui la guida riconosce l'arrivo.", tab: "luoghi" },
  GEOFENCE_OVERLAP: { title: (n) => `${plural(n, "Due aree di arrivo si sovrappongono", "aree di arrivo si sovrappongono")}`, todo: "Riduci i raggi dei luoghi vicini.", tab: "luoghi" },
  PRACTICAL_STALE: { title: (n) => `${plural(n, "Un'informazione pratica è", "informazioni pratiche sono")} da ricontrollare`, todo: "Aggiorna orari e informazioni pratiche.", tab: "luoghi" },
  ROUTE_NOT_CALIBRATED: { title: (n) => `${plural(n, "Un percorso ha", "percorsi hanno")} tempi non ancora misurati`, todo: "Percorrilo sul campo e registra i tempi.", tab: "percorsi" },
  ROUTE_STOP_REPEATED: { title: (n) => `${plural(n, "Un percorso ripete", "percorsi ripetono")} una tappa`, todo: "Togli la tappa doppia.", tab: "percorsi" },
  ROUTE_STOP_KIND: { title: (n) => `${plural(n, "Un percorso ha", "percorsi hanno")} una tappa che non è un luogo`, todo: "Usa come tappe solo luoghi.", tab: "percorsi" },
  ROUTE_ANCHOR_UNKNOWN: { title: (n) => `${plural(n, "Un percorso parte", "percorsi partono")} da un punto che non esiste`, todo: "Scegli un punto di partenza esistente.", tab: "percorsi" },
  ACCESS_NO_INTRO: { title: () => "Esplorazione a pagamento senza luoghi introduttivi", todo: "Scegli fino a 3 luoghi gratuiti.", tab: "vendita" },
  ACCESS_INTRO_NO_OPENING: { title: (n) => `${plural(n, "Un luogo introduttivo non ha", "luoghi introduttivi non hanno")} il racconto d'apertura`, todo: "Scrivi il racconto d'apertura o scegli un altro luogo.", tab: "vendita" },
  ACCESS_INTRO_UNKNOWN: { title: (n) => `${plural(n, "Un luogo introduttivo non esiste", "luoghi introduttivi non esistono")} più`, todo: "Rivedi i luoghi introduttivi.", tab: "vendita" },
  ACCESS_ROUTE_UNKNOWN: { title: (n) => `${plural(n, "Un percorso a pagamento non esiste", "percorsi a pagamento non esistono")} più`, todo: "Rivedi i percorsi a pagamento.", tab: "vendita" },
  TEXT_MISSING_LOCALE: { title: (n) => `${plural(n, "Un testo manca", "testi mancano")} in una delle lingue`, todo: "Completa la traduzione (il dettaglio dice quale elemento)." },
  LABEL_MISSING_LOCALE: { title: (n) => `${plural(n, "Un nome manca", "nomi mancano")} in una delle lingue`, todo: "Completa la traduzione (il dettaglio dice quale elemento)." },
  NAME_MISSING: { title: (n) => `${plural(n, "Un elemento è", "elementi sono")} senza nome`, todo: "Dai un nome (il dettaglio dice quale)." },
  UNRESOLVED_REF: { title: (n) => `${plural(n, "Un collegamento punta", "collegamenti puntano")} a qualcosa che non esiste`, todo: "Il dettaglio dice quale elemento: correggilo o toglilo." },
  INVALID_REF: { title: (n) => `${plural(n, "Un codice non è", "codici non sono")} scritti correttamente`, todo: "Il dettaglio dice quale elemento correggere." },
  UNDECLARED_DEPENDENCY: { title: (n) => `${plural(n, "Un elemento usa", "elementi usano")} un altro territorio senza dichiararlo`, todo: "In Panoramica, aggiungi quel territorio in «Fa parte di».", tab: "panoramica" },
  DEPENDENCY_UNREADABLE: { title: () => "Non puoi leggere un territorio da cui questo dipende", todo: "Il controllo completo lo fa chi ha accesso a entrambi." },
  CONTAINER: { title: () => "Regioni e aree non arrivano nell'app da sole", todo: "Arrivano con le destinazioni che ne fanno parte: pubblica quelle." },
  BUNDLE: { title: () => "La preparazione per l'app non è riuscita", todo: "Leggi il dettaglio tecnico; se non è chiaro, chiedi a chi gestisce la piattaforma." },
  SCHEMA: { title: (n) => `${plural(n, "Un dato non è", "dati non sono")} nel formato previsto`, todo: "Il dettaglio dice quale elemento correggere." },
  STATIC_PREMIUM: {
    title: () => "Contenuti a pagamento su una destinazione distribuita anche dai file dell'app",
    todo: "Così resterebbero gratuiti per tutti: o torni al gratuito nella Vendita, o la destinazione va tolta dai file dell'app (serve uno sviluppatore).",
    tab: "vendita",
  },
  NOT_FOUND: { title: () => "Territorio non trovato", todo: "Controlla di avere accesso a questo territorio." },
};

/** Fonte citata con il codice di un altro territorio (es. «it.liguria:unesco-826»). */
const foreignSource = (message: string, pack: string): string | null => {
  const m = /fonte non trovata o non raggiungibile: ([a-z0-9._-]+):/.exec(message);
  return m && m[1] !== pack ? m[1]! : null;
};

/** Raggruppa e spiega. Prima gli errori (bloccano la pubblicazione), poi gli avvisi; dentro, i più frequenti. */
export function explainIssues(issues: ReadinessIssue[], pack: string): ExplainedGroup[] {
  const groups = new Map<string, ExplainedGroup>();
  for (const i of issues) {
    const key = `${i.level}:${i.code}`;
    let g = groups.get(key);
    if (!g) {
      g = { code: i.code, level: i.level, count: 0, title: "", todo: "", details: [] };
      groups.set(key, g);
    }
    g.count++;
    g.details.push(i.pack !== pack ? `(${i.pack}) ${i.message}` : i.message);
  }
  for (const g of groups.values()) {
    const rule = RULES[g.code];
    g.title = rule ? rule.title(g.count) : `${plural(g.count, "Un problema", "problemi")} da controllare`;
    g.todo = rule?.todo ?? "Leggi il dettaglio tecnico qui sotto.";
    if (rule?.tab) g.fix = { tab: rule.tab, label: TAB_LABELS[rule.tab] };
    if (g.code === "SOURCE_NOT_FOUND") {
      const others = [...new Set(g.details.map((d) => foreignSource(d, pack)).filter((x): x is string => x !== null))];
      if (others.length) {
        g.todo = `Le fonti citate sono del territorio ${others.join(", ")}. Controlla che esista ancora la fonte in quel territorio, e che in Panoramica questo territorio ne «faccia parte»: senza il collegamento le sue fonti non sono raggiungibili.`;
        g.fix = { tab: "panoramica", label: TAB_LABELS.panoramica };
      }
    }
  }
  return [...groups.values()].sort((a, b) => (a.level === b.level ? b.count - a.count : a.level === "error" ? -1 : 1));
}
