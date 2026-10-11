/**
 * Solo per /studio: rinnova la sessione Supabase nei cookie e manda all'accesso chi non è autenticato.
 * È un controllo ottimistico; quello vero lo fa ogni pagina e ogni azione (lib/studio/server.ts).
 * La guida turistica non passa di qui.
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { readStudioConfig } from "./lib/studio/shared";

export async function proxy(request: NextRequest) {
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
  matcher: ["/studio", "/studio/:path*"],
};
