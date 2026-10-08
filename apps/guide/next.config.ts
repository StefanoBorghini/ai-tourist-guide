import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // I pacchetti del monorepo sono distribuiti come sorgenti TypeScript.
  transpilePackages: ["@guide/domain", "@guide/bundle", "@guide/context-engine", "@guide/narrative-planner"],
  // La route delle domande legge i bundle compilati dal disco: vanno inclusi nella funzione.
  outputFileTracingIncludes: { "/api/guide/ask": ["./public/bundles/**/*.json"] },
};

export default nextConfig;
