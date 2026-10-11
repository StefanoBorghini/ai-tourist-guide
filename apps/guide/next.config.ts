import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // I pacchetti del monorepo sono distribuiti come sorgenti TypeScript.
  transpilePackages: ["@guide/domain", "@guide/bundle", "@guide/context-engine", "@guide/narrative-planner", "@guide/territory-pack"],
  outputFileTracingIncludes: {
    // La route delle domande legge i bundle compilati dal disco: vanno inclusi nella funzione.
    "/api/guide/ask": ["./public/bundles/**/*.json"],
    // Lo Studio copia nel bucket i file media dei territori nati dal repository (Foto → «Copia i file dal repository»).
    "/studio/**": ["../../territories/*/media/files/*", "../../territories/*/*/media/files/*"],
  },
  // Bundle pubblicati dallo Studio (/pub/ → bucket pubblico «bundles» di Supabase, sullo stesso dominio dell'app):
  // la riscrittura è in proxy.ts, che aggiunge le intestazioni di sicurezza alle risposte.
};

export default nextConfig;
