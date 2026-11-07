/**
 * Invito a raccontare un luogo su Instagram (config.social della destinazione, nel bundle come `content.social`).
 *
 * Limiti di Instagram: da un sito o da una PWA non c'è un modo documentato per precompilare un post, un Reel o una
 * Storia. La Storia «pronta» (sfondo e adesivo) richiede un'app nativa che passa un ID app Facebook (documentazione
 * Meta «Sharing to Stories», obbligatorio da gennaio 2023); l'API di pubblicazione pubblica solo sul proprio account.
 * Su iOS, passando insieme testo e file al menu «Condividi», i file possono andare persi: si passa solo la foto.
 * Quindi la guida:
 * 1. prepara un testo (luogo, account da taggare, hashtag) e lo copia negli appunti con un tocco;
 * 2. fa scegliere una foto e la passa al menu «Condividi» del telefono (Web Share API con file), dove il visitatore
 *    sceglie Instagram e poi Post, Reel o Storia; Instagram ignora il testo passato insieme, perciò lo si copia prima;
 * 3. in alternativa apre il profilo dell'account (sul telefono si apre nell'app) e lascia incollare il testo.
 * Nessun collegamento non ufficiale (instagram://…), nessuna raccolta di dati. Logica pura, testata.
 */

export interface InstagramShare {
  handle: string;
  hashtags: string[];
}

/** Configurazione della destinazione, se c'è e ha un account valido (bundle di un'altra versione: si ignora). */
export function instagramOf(content: { social?: { instagram?: { handle?: unknown; hashtags?: unknown } } }): InstagramShare | null {
  const ig = content.social?.instagram;
  if (!ig || typeof ig.handle !== "string" || !/^[A-Za-z0-9._]{1,30}$/.test(ig.handle)) return null;
  const hashtags = Array.isArray(ig.hashtags) ? ig.hashtags.filter((h): h is string => typeof h === "string" && /^[^\s#]{1,60}$/u.test(h)) : [];
  return { handle: ig.handle, hashtags: hashtags.slice(0, 5) };
}

/**
 * Testo da incollare nella didascalia: il luogo (con la destinazione, se è un altro nome), poi account e hashtag.
 * Niente link: nelle didascalie di Instagram non sono cliccabili (il link si copia a parte, per l'adesivo «Link»).
 */
export function shareCaption(ig: InstagramShare, placeName: string, destinationName: string): string {
  const where = sameName(placeName, destinationName) ? placeName : `${placeName} · ${destinationName}`;
  const tags = [`@${ig.handle}`, ...ig.hashtags.map((h) => `#${h}`)].join(" ");
  return `📍 ${where}\n${tags}`;
}

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** Profilo dell'account: sul telefono il collegamento ufficiale apre l'app Instagram, altrimenti il sito. */
export const profileUrl = (handle: string) => `https://www.instagram.com/${encodeURIComponent(handle)}/`;

// ---------------------------------------------------------------- collegamento al singolo luogo (?p=)

/** Valore accettato per `p` nell'indirizzo: lo slug del luogo o, se è di un altro pack, il riferimento completo. */
export const PLACE_PARAM_RE = /^[a-z0-9][a-z0-9.-]{0,120}(:[a-z0-9][a-z0-9-]{0,80})?$/;

/** Riferimento del luogo («pack:slug») → valore per `p`: lo slug quando il luogo è della destinazione stessa. */
export function placeParam(ref: string, destination: string): string {
  return ref.startsWith(`${destination}:`) ? ref.slice(destination.length + 1) : ref;
}

/** Valore di `p` → riferimento del luogo, se esiste tra quelli dati. */
export function placeFromParam(p: string | null, destination: string, refs: Iterable<string>): string | null {
  if (!p || !PLACE_PARAM_RE.test(p)) return null;
  const wanted = p.includes(":") ? p : `${destination}:${p}`;
  for (const r of refs) if (r === wanted) return r;
  return null;
}

/** Indirizzo pubblico del luogo nella guida: apre la destinazione con la scheda del luogo. */
export function placeShareUrl(origin: string, pathname: string, destination: string, ref: string): string {
  const q = new URLSearchParams({ d: destination, p: placeParam(ref, destination) });
  return `${origin}${pathname}?${q.toString()}`;
}

// ---------------------------------------------------------------- cosa sa fare il dispositivo

/** Il browser passa un file al menu «Condividi» del sistema (telefoni; quasi mai i computer). */
export function canShareFile(nav: { canShare?: (data: { files: File[] }) => boolean } | undefined, file: File): boolean {
  try {
    return typeof nav?.canShare === "function" && nav.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/** Telefono o tablet (per scegliere i testi: dal computer si pubblica dal sito di Instagram). */
export const isMobileUa = (ua: string) => /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
