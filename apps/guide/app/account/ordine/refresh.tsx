"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { markPurchaseDone } from "../../../lib/purchase-watch";

/** Ricarica i dati della pagina finché l'ordine è in attesa (al massimo ~1 minuto): l'esito arriva dal webhook. */
export function AutoRefresh() {
  const router = useRouter();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (count >= 20) return;
    const t = setTimeout(() => {
      setCount((c) => c + 1);
      router.refresh();
    }, 3000);
    return () => clearTimeout(t);
  }, [count, router]);
  return null;
}

/**
 * Pagamento confermato: lo si dice alla guida aperta in un'altra finestra o nell'app installata (evento `storage`),
 * che chiede subito gli acquisti e si sblocca da sola (lib/purchase-watch.ts). Nessun dato dell'ordine, solo l'istante.
 */
export function PurchaseDone() {
  useEffect(() => markPurchaseDone(), []);
  return null;
}
