/**
 * Posizione bloccata dal visitatore («Non consentire mai»): il browser non mostra più la richiesta e il sito non può
 * riaprirla. Si può solo spiegare come riattivarla, per il telefono in uso, e ripartire da soli quando torna
 * concessa. Logica pura, testata; i testi sono in lib/i18n.ts.
 */

export type GeoPlatform = "android" | "android-app" | "ios" | "ios-app" | "other";

/** Telefono e modo d'uso (browser o app installata) dall'user agent: serve solo a scegliere le istruzioni. */
export function geoPlatform(userAgent: string, standalone: boolean): GeoPlatform {
  const ios = /iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && /Mobile/i.test(userAgent));
  if (ios) return standalone ? "ios-app" : "ios";
  if (/Android/i.test(userAgent)) return standalone ? "android-app" : "android";
  return "other";
}

/** Lo stato del permesso dice che ora la posizione si può chiedere di nuovo (dopo che era stata bloccata). */
export const shouldResume = (permission: string | null, error: string | null) => error === "denied" && permission === "granted";
