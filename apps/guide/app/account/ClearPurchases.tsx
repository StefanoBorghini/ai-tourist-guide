"use client";
/**
 * Dopo l'uscita dall'account (o la sua eliminazione) toglie dal dispositivo i contenuti acquistati: restano
 * dell'account e tornano al prossimo accesso. Vale anche se subito dopo il telefono resta senza rete.
 */
import { useEffect } from "react";
import { clearPremium } from "../../lib/premium-client";

export function ClearPurchases() {
  useEffect(() => clearPremium(), []);
  return null;
}
