import type { MetadataRoute } from "next";

/** Manifest della PWA: l'app si installa sulla schermata Home e si apre a schermo intero. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AI Guide",
    short_name: "AI Guide",
    description: "Guida turistica personale: luoghi, storie e mappa, anche senza rete.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f7f3ec",
    theme_color: "#10243e",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
