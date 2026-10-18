/**
 * Contenuti acquistati di un bundle pubblicato: indirizzi firmati di pochi minuti per i soli file a pagamento che le
 * policy del bucket «premium» concedono all'utente (con la sua sessione: nessuna chiave di servizio), più la data
 * fino a cui si usano senza rete. Vedi docs/v0.3-platform/CONSEGNA-CONTENUTI.md.
 */
import type { BundleManifest } from "@guide/bundle/client";
import { NextResponse } from "next/server";
import { accountClient, accountSetup } from "../../../lib/account/server";
import { publishedOrigin, pubToStorageUrl } from "../../../lib/bundle-index";
import { offlineUntil, PREMIUM_BUCKET, premiumEntries, premiumTarget, SIGNED_URL_SECONDS, type PremiumGrant } from "../../../lib/premium";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reply = (body: PremiumGrant, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const none = (enabled: boolean, signedIn: boolean): PremiumGrant => ({ enabled, signedIn, parts: [], validUntil: null });

export async function GET(request: Request) {
  const manifestUrl = new URL(request.url).searchParams.get("manifest");
  const target = premiumTarget(manifestUrl);
  if (!target) return reply(none(false, false), 400);
  const account = accountSetup();
  const origin = publishedOrigin();
  if (!account.ok || !origin) return reply(none(false, false));
  const supabase = await accountClient(account.config);
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return reply(none(true, false));

  // Il manifest pubblico in linea dice quali file esistono; quali si possono leggere lo dice il database.
  let manifest: BundleManifest;
  try {
    const res = await fetch(pubToStorageUrl(manifestUrl!, origin), { cache: "no-store" });
    if (!res.ok) return reply(none(true, true), 404);
    manifest = (await res.json()) as BundleManifest;
  } catch {
    return reply(none(true, true), 502);
  }
  const parts: PremiumGrant["parts"] = [];
  for (const entry of premiumEntries(manifest, target)) {
    // Solo con un diritto (premium_object_readable, migrazioni 27–28). Le policy del bucket lasciano leggere i file
    // anche a chi pubblica il territorio (serve alla pipeline): senza questo controllo la redazione, collegata
    // con lo stesso account anche nella guida, vedeva sbloccato tutto come se l'avesse comprato.
    const { data: entitled } = await supabase.rpc("premium_object_readable", { p_name: entry.path });
    if (entitled !== true) continue;
    const { data } = await supabase.storage.from(PREMIUM_BUCKET).createSignedUrl(entry.path, SIGNED_URL_SECONDS);
    if (data?.signedUrl) parts.push({ entry, url: data.signedUrl });
  }
  return reply({ enabled: true, signedIn: true, parts, validUntil: offlineUntil(Date.now()) });
}
