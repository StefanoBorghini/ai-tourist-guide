/**
 * Manifest della PWA: l'app si installa sulla schermata Home e si apre a schermo intero.
 * È una route (non app/manifest.ts) perché il link nel layout deve avere crossorigin="use-credentials": senza,
 * Chrome scarica il manifest senza cookie e dietro una protezione d'accesso (anteprime di Vercel) riceve «non
 * autorizzato», e l'app risulta «non installabile».
 */
export const dynamic = "force-static";

const MANIFEST = {
  name: "AI Guide",
  short_name: "AI Guide",
  description: "Guida turistica personale: luoghi, storie e mappa, anche senza rete.",
  id: "/",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#0c0c0c",
  theme_color: "#0c0c0c",
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

export function GET() {
  return new Response(JSON.stringify(MANIFEST), { headers: { "content-type": "application/manifest+json" } });
}
