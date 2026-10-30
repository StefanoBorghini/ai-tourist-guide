import type { NextConfig } from "next";

/**
 * Intestazioni di sicurezza su ogni risposta dell'app. Nessuna pagina va mostrata dentro un riquadro di un altro sito
 * (clickjacking: un sito terzo potrebbe incorporare lo Studio e far cliccare «Elimina» o «Pubblica» a chi è collegato);
 * niente interpretazione del tipo dei file; l'indirizzo completo non esce verso altri siti.
 * Le risposte /pub/ riscritte verso il bucket hanno le loro intestazioni in proxy.ts.
 */
export const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // Versione in esecuzione (commit del deploy su Vercel), mostrata nel pannello di debug.
  env: { NEXT_PUBLIC_BUILD_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? "" },
  // I pacchetti del monorepo sono distribuiti come sorgenti TypeScript.
  transpilePackages: ["@guide/domain", "@guide/bundle", "@guide/context-engine", "@guide/narrative-planner", "@guide/territory-pack"],
  outputFileTracingIncludes: {
    // La route delle domande legge i bundle compilati dal disco: vanno inclusi nella funzione.
    "/api/guide/ask": ["./public/bundles/**/*.json"],
    // Lo Studio copia nel bucket i file media dei territori nati dal repository (Foto → «Copia i file dal repository»).
    // …e legge l'indice dei bundle statici: niente contenuti a pagamento per le destinazioni che ci sono.
    "/studio/**": ["../../territories/*/media/files/*", "../../territories/*/*/media/files/*", "./public/bundles/index.json"],
  },
  // Bundle pubblicati dallo Studio (/pub/ → bucket pubblico «bundles» di Supabase, sullo stesso dominio dell'app):
  // la riscrittura è in proxy.ts, che aggiunge le intestazioni di sicurezza alle risposte.
};

export default nextConfig;
