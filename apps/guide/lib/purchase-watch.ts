/**
 * Acquisto in corso: dopo il pagamento la guida si sblocca da sola, senza ricaricare. Il diritto arriva solo dal
 * webhook firmato di Stripe, qualche secondo dopo il ritorno; e nell'app installata la cassa e la pagina dell'ordine
 * possono aprirsi in un'altra finestra (sopra l'app, che non vede né un ricaricamento né un cambio di visibilità).
 * Per questo la guida, mentre un acquisto partito da lei è recente, richiede gli acquisti a intervalli regolari
 * finché ne arriva uno nuovo; la pagina dell'ordine, a pagamento confermato, lo segnala alle altre finestre.
 *
 * Nel dispositivo restano solo due istanti (nessun dato dell'ordine). Logica pura, testata.
 */

export const PURCHASE_PENDING_KEY = "guide-purchase-pending";
export const PURCHASE_DONE_KEY = "guide-purchase-done";
/** Oltre questo tempo dalla partenza verso la cassa non si aspetta più (il pagamento è stato abbandonato). */
export const PURCHASE_WATCH_MS = 15 * 60_000;
/** Ogni quanto si richiedono gli acquisti mentre si aspetta. */
export const PURCHASE_POLL_MS = 4_000;

/** Istante salvato (millisecondi), o null se manca o non è valido. */
export function readStamp(raw: string | null): number | null {
  if (!raw || !/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * Si continua ad aspettare? Sì se un acquisto è partito da poco (e non nel futuro: orologio cambiato) e non è già
 * stata fatta una richiesta dopo la conferma della pagina dell'ordine (da lì in poi il server ha già il diritto).
 */
export function watchingPurchase(pending: number | null, done: number | null, lastSync: number | null, now: number): boolean {
  if (pending === null || now < pending || now - pending > PURCHASE_WATCH_MS) return false;
  if (done !== null && done >= pending && lastSync !== null && lastSync >= done) return false;
  return true;
}

function get(key: string): number | null {
  try {
    return readStamp(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function set(key: string, value: number | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {
    // Archiviazione non disponibile: resta lo sblocco al ritorno nella guida.
  }
}

/** La guida manda alla cassa. */
export const markPurchaseStarted = (now = Date.now()) => set(PURCHASE_PENDING_KEY, now);
/** La pagina dell'ordine ha visto il pagamento confermato. */
export const markPurchaseDone = (now = Date.now()) => set(PURCHASE_DONE_KEY, now);
/** Acquisto arrivato (o attesa scaduta): niente più richieste. */
export function clearPurchaseWatch() {
  set(PURCHASE_PENDING_KEY, null);
  set(PURCHASE_DONE_KEY, null);
}
export const purchaseStamps = () => ({ pending: get(PURCHASE_PENDING_KEY), done: get(PURCHASE_DONE_KEY) });
