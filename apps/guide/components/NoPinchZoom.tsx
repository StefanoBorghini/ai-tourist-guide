"use client";

import { useEffect } from "react";

/**
 * Niente zoom con due dita sull'app (decisione del 2026-10-18): come un'app nativa. La mappa resta zoomabile, perché
 * gestisce da sé il pizzico (MapView, `touch-action: none` su `.map-box`). Il blocco vero sta nel CSS
 * (`touch-action: pan-x pan-y` sulla pagina) e nel viewport; qui solo Safari su iPhone e iPad, che ignora
 * `user-scalable=no` e manda i suoi eventi «gesture» anche dove il CSS dovrebbe bastare.
 */
export function NoPinchZoom() {
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    document.addEventListener("gesturestart", block, { passive: false });
    document.addEventListener("gesturechange", block, { passive: false });
    return () => {
      document.removeEventListener("gesturestart", block);
      document.removeEventListener("gesturechange", block);
    };
  }, []);
  return null;
}
