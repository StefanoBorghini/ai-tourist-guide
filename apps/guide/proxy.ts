/**
 * Per /studio: rinnova la sessione Supabase nei cookie e manda all'accesso chi non è autenticato.
 * È un controllo ottimistico; quello vero lo fa ogni pagina e ogni azione (lib/studio/server.ts).
 * La guida turistica non passa di qui.
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { publishedOrigin, pubToStorageUrl } from "./lib/bundle-index";
import { readStudioConfig } from "./lib/studio/shared";

/**
 * File pubblicati dallo Studio (/pub/, riscritti verso il bucket «bundles»): sono dati, mai pagine. Niente script
 * né interpretazione del tipo, anche se nel bucket finisse un file inatteso (oltre ai tipi e ai percorsi che il
 * bucket ammette). Le intestazioni di next.config non arrivano alle risposte riscritte verso un altro dominio.
 */
const PUB_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
};

export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/pub/")) {
    // La riscrittura verso il bucket la fa qui (non in next.config): così le intestazioni restano sulla risposta.
    const origin = publishedOrigin({ NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL });
    if (!origin) return new NextResponse(null, { status: 404 });
    const response = NextResponse.rewrite(new URL(pubToStorageUrl(request.nextUrl.pathname, origin) + request.nextUrl.search));
    for (const [k, v] of Object.entries(PUB_HEADERS)) response.headers.set(k, v);
    return response;
  }
  const config = readStudioConfig({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  const isLogin = request.nextUrl.pathname === "/studio/login";
  if (!config) return isLogin ? NextResponse.next() : NextResponse.redirect(new URL("/studio/login", request.url));

  let response = NextResponse.next({ request });
  const supabase = createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list, headers) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
      },
    },
  });
  const { data } = await supabase.auth.getUser();
  if (!data.user && !isLogin) return NextResponse.redirect(new URL("/studio/login", request.url));
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

export const config = {
  matcher: ["/studio", "/studio/:path*", "/pub/:path*"],
};
