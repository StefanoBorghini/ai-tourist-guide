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
  // Bundle pubblicati dallo Studio: bucket pubblico «bundles» di Supabase servito sotto /pub/, sullo stesso
  // dominio dell'app (service worker e uso senza rete funzionano come per /bundles/). Senza Supabase
  // configurato non c'è nulla da servire e l'app usa solo i bundle compilati dai file.
  async rewrites() {
    // Stessa regola di publishedOrigin() in lib/bundle-index.ts (qui senza importare codice dell'app).
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, "");
    const origin = url && /^https?:\/\/[^/]+$/.test(url) ? url : null;
    return origin ? [{ source: "/pub/:path*", destination: `${origin}/storage/v1/object/public/bundles/:path*` }] : [];
  },
};

export default nextConfig;
