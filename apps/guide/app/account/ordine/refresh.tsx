"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

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
