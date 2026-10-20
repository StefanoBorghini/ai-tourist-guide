/**
 * Prima di tutto, se è attiva, la protezione del sito con nome utente e password (lib/site-lock.ts): vale per ogni
 * pagina, file e API, tranne il webhook di Stripe.
 *
 * Per /studio e per l'account dei visitatori (/account, /auth): rinnova la sessione Supabase nei cookie e manda
 * all'accesso chi non è autenticato. È un controllo ottimistico; quello vero lo fa ogni pagina e ogni azione
 * (lib/studio/server.ts, lib/account/server.ts). Il resto della guida passa di qui solo per la protezione del sito.
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { BUNDLES_BUCKET, currentIndexObject, listIndexObjects, PUB_INDEX_URL, publishedOrigin, pubToStorageUrl } from "./lib/bundle-index";
import { readStudioConfig } from "./lib/studio/shared";
import { accountEnv, readAccountConfig, requiresSession, SIGN_IN } from "./lib/account/shared";
import { siteLockDecision, siteLockFromEnv } from "./lib/site-lock";

/**
 * File pubblicati dallo Studio (/pub/, riscritti verso il bucket «bundles»): sono dati, mai pagine. Niente script
 * né interpretazione del tipo, anche se nel bucket finisse un file inatteso (oltre ai tipi e ai percorsi che il
 * bucket ammette). Le intestazioni di next.config non arrivano alle risposte riscritte verso un altro dominio.
 */
const PUB_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
};

/**
 * /pub/index.json: la fotografia numerata più alta di index/ (immutabili: un processo sospeso che carica tardi una
 * fotografia vecchia non la rende mai quella servita), oppure il vecchio index.json finché non ce n'è nessuna.
 * Se l'elenco non risponde: 503, mai un indice più vecchio al posto di quello in vigore.
 */
async function publishedIndexResponse(origin: string): Promise<NextResponse> {
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const found = anonKey ? await currentIndexObject(listIndexObjects(origin, anonKey)) : { ok: false as const, error: "chiave pubblica mancante" };
  if (!found.ok) {
    const failed = new NextResponse(null, { status: 503 });
    for (const [k, v] of Object.entries(PUB_HEADERS)) failed.headers.set(k, v);
    failed.headers.set("Cache-Control", "no-store");
    return failed;
  }
  const response = NextResponse.rewrite(new URL(`${origin}/storage/v1/object/public/${BUNDLES_BUCKET}/${found.object}`));
  for (const [k, v] of Object.entries(PUB_HEADERS)) response.headers.set(k, v);
  response.headers.set("Cache-Control", "no-cache");
  return response;
}

/** Client Supabase che rinnova la sessione: i cookie aggiornati finiscono nella risposta restituita. */
function sessionClient(request: NextRequest, url: string, anonKey: string) {
  const state = { response: NextResponse.next({ request }) };
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list, headers) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        state.response = NextResponse.next({ request });
        for (const { name, value, options } of list) state.response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers ?? {})) state.response.headers.set(key, value);
      },
    },
  });
  return { supabase, state };
}

/** Account dei visitatori: senza configurazione le pagine dicono che non sono disponibili; altrimenti sessione e accesso. */
async function accountProxy(request: NextRequest): Promise<NextResponse> {
  const setup = readAccountConfig(accountEnv());
  if (!setup.ok) return withNoIndex(NextResponse.next());
  const { supabase, state } = sessionClient(request, setup.config.supabase.url, setup.config.supabase.anonKey);
  const { data } = await supabase.auth.getUser();
  if (!data.user && requiresSession(request.nextUrl.pathname)) {
    const to = new URL(SIGN_IN, request.url);
    to.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
    return withNoIndex(NextResponse.redirect(to));
  }
  return withNoIndex(state.response);
}

function withNoIndex(response: NextResponse): NextResponse {
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function proxy(request: NextRequest) {
  const lock = siteLockDecision(
    request.nextUrl.pathname,
    request.headers.get("authorization"),
    siteLockFromEnv({ SITE_USERNAME: process.env.SITE_USERNAME, SITE_PASSWORD: process.env.SITE_PASSWORD }),
  );
  if (lock) return new NextResponse("Accesso riservato.", { status: lock.status, headers: lock.headers });
  if (!/^\/(studio|pub|account|auth)(\/|$)/.test(request.nextUrl.pathname)) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/pub/")) {
    // La riscrittura verso il bucket la fa qui (non in next.config): così le intestazioni restano sulla risposta.
    const origin = publishedOrigin({ NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL });
    if (!origin) return new NextResponse(null, { status: 404 });
    if (request.nextUrl.pathname === PUB_INDEX_URL) return publishedIndexResponse(origin);
    const response = NextResponse.rewrite(new URL(pubToStorageUrl(request.nextUrl.pathname, origin) + request.nextUrl.search));
    for (const [k, v] of Object.entries(PUB_HEADERS)) response.headers.set(k, v);
    return response;
  }
  if (/^\/(account|auth)(\/|$)/.test(request.nextUrl.pathname)) return accountProxy(request);
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
  // Tutto, perché la protezione del sito vale ovunque; le parti statiche di Next passano comunque dal controllo
  // (un estraneo non deve poter scaricare nemmeno quelle). Le regole di Studio e account restano sui loro percorsi.
  matcher: ["/:path*"],
};
