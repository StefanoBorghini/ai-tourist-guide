/**
 * Icone dell'interfaccia: tratto sottile, stesso stile ovunque, nessuna dipendenza esterna.
 * Decorative per default (aria-hidden): il significato lo porta il testo accanto.
 */
const PATHS = {
  back: "M15 18l-6-6 6-6",
  forward: "M9 18l6-6-6-6",
  close: "M6 6l12 12M18 6L6 18",
  play: "M8 5.5v13l10.5-6.5z",
  pause: "M8 5v14M16 5v14",
  skip: "M6 5.5v13l9-6.5zM18 5v14",
  chat: "M4 5.5h16v10H9l-5 4z",
  pin: "M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0113 0c0 4.8-6.5 11-6.5 11zM12 12.2a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4z",
  map: "M3.5 6.5l5.5-2 6 2 5.5-2v13l-5.5 2-6-2-5.5 2zM9 4.5v13M15 6.5v13",
  list: "M8.5 6.5h12M8.5 12h12M8.5 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01",
  route: "M6 19a2 2 0 100-4 2 2 0 000 4zM18 9a2 2 0 100-4 2 2 0 000 4zM6 15V9.5A3.5 3.5 0 019.5 6H12M18 9v5.5a3.5 3.5 0 01-3.5 3.5H12",
  compass: "M12 21a9 9 0 100-18 9 9 0 000 18zM15.5 8.5l-2 5-5 2 2-5z",
  mic: "M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3zM5.5 11.5a6.5 6.5 0 0013 0M12 18v3",
  send: "M4.5 12h14M13 6l6 6-6 6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7.5V12l3 2",
  steps: "M5 18h4v-4h4v-4h4V6h2",
  sparkle: "M12 3.5l1.8 5 5 1.8-5 1.8-1.8 5-1.8-5-5-1.8 5-1.8zM18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z",
  wifiOff: "M3 3l18 18M8.5 16.5a5 5 0 017 0M5 13a10 10 0 015.2-2.8M19 13a10 10 0 00-2.6-1.9M2 9.5a15 15 0 015.5-3.2M22 9.5A15 15 0 0011 4.5M12 20h.01",
  globe: "M12 21a9 9 0 100-18 9 9 0 000 18zM3.5 9h17M3.5 15h17M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z",
  download: "M12 4v11M7 10.5l5 5 5-5M5 20h14",
  volume: "M4 9.5v5h3.5L12 18.5v-13L7.5 9.5zM15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11",
  walk: "M13 4.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM10 21l2-6 2.5 2.5V21M8 12l2-4.5 3.5 1 2 3.5 2.5 1M10 7.5l-2.5 4",
  info: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5.5M12 7.8h.01",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  const filled = name === "play" || name === "skip";
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
