import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // I pacchetti del monorepo sono distribuiti come sorgenti TypeScript.
  transpilePackages: ["@guide/domain", "@guide/bundle", "@guide/context-engine", "@guide/narrative-planner"],
};

export default nextConfig;
