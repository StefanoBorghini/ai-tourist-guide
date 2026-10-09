/** Formattazione di distanze e direzioni per l'interfaccia: logica pura, testata. */

/** "35 m", "120 m", "1,2 km" (arrotondamenti leggibili mentre si cammina). */
export function formatDistance(meters: number, locale: string): string {
  if (meters < 1000) return `${meters < 100 ? Math.round(meters / 5) * 5 : Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} km`;
}

/** Direzione cardinale (8 settori) da un angolo in gradi da nord. */
export function compass(bearingDeg: number, words: readonly string[]): string {
  return words[Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8]!;
}
