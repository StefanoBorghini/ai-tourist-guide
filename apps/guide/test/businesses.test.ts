import { describe, expect, it } from "vitest";
import { businessesReply, businessesRpcArgs, businessPhotoUrl, parseBusinessesQuery, type BusinessesRpc } from "../lib/businesses-api.ts";
import { NO_STORE, PUBLIC_CACHE } from "../lib/events-api.ts";
import {
  parseExploreTheme, venueMarkers,
  businessCategoriesIn, businessesStateFromResponse, distanceLabel, hoursFresh, listBusinesses, parseBusinessesData, telHref,
  type BusinessesData,
} from "../lib/businesses-view.ts";

const q = (s: string) => new URLSearchParams(s);
const T = "territory=it.liguria.sp.portovenere";
const DAY = 86_400_000;
const now = Date.parse("2026-10-28T10:00:00Z");

const raw = {
  territory: { id: "it.liguria.sp.portovenere" },
  lang: "it",
  businesses: [
    { id: "a", name: "Bar Alba", category: "bar", subcategory: "caffè", lat: 44.0510, lng: 9.8350, phone: "+39 0187 000000", verifiedAt: "2026-10-01T10:00:00Z", hours: "7–20",
      photos: [
        { url: "https://x.supabase.co/storage/v1/object/public/business-photos/a.jpg", alt: "Il bancone", author: "Mario Rossi", license: "cc-by-4.0", originalUrl: null },
        { url: "https://x.supabase.co/b.jpg", alt: "Sala", author: null, license: "cc0", originalUrl: "https://commons.example.org/b" },
        { url: "javascript:alert(1)", alt: "No" },
        { url: "https://x.supabase.co/c.jpg", alt: "" },
        { url: "http://localhost:54400/d.jpg", alt: "Locale", author: "Anna", license: "own", originalUrl: "http://non-sicuro.example.org" },
      ] },
    { id: "b", name: "Negozio Senza Posizione", category: "shop", website: "https://negozio.example.it", email: "info@negozio.example.it" },
    { id: "c", name: "Trattoria Lontana", category: "restaurant", lat: 44.0600, lng: 9.8400, website: "http://non-sicuro.example.it", phone: "chiamami" },
    { id: "d", name: "", category: "bar" },
    { id: "e", name: "Strana", category: "casinò", lat: 120, lng: 9 },
  ],
};

describe("API delle attività", () => {
  it("parametri: territorio ben formato, lingua facoltativa di due lettere", () => {
    expect(parseBusinessesQuery(q(T))).toEqual({ territory: "it.liguria.sp.portovenere", lang: null });
    expect(parseBusinessesQuery(q(`${T}&lang=en`))).toEqual({ territory: "it.liguria.sp.portovenere", lang: "en" });
    expect(parseBusinessesQuery(q(""))).toBeNull();
    expect(parseBusinessesQuery(q("territory=../x"))).toBeNull();
    expect(parseBusinessesQuery(q(`${T}&lang=eng`))).toBeNull();
    expect(businessesRpcArgs({ territory: "x.y", lang: null })).toEqual({ p_pack: "x.y", p_lang: null });
  });

  it("esiti: 200 in cache, territorio sconosciuto 404, errori mai in cache e mai inoltrati", async () => {
    const rpc = (data: unknown, error: { code?: string } | null = null): BusinessesRpc => async () => ({ data, error });
    const ok = await businessesReply(q(T), rpc(raw));
    expect(ok.status).toBe(200);
    expect(ok.cacheControl).toBe(PUBLIC_CACHE);
    expect(ok.body.version).toBe(1);
    expect((await businessesReply(q(T), rpc(null))).status).toBe(404);
    expect(await businessesReply(q("territory=!"), rpc(raw))).toMatchObject({ status: 400, cacheControl: NO_STORE });
    expect(await businessesReply(q(T), null)).toMatchObject({ status: 503, body: { error: "non_configurato" } });
    const failed = await businessesReply(q(T), rpc(null, { code: "XX000" }));
    expect(failed).toMatchObject({ status: 503, cacheControl: NO_STORE, body: { error: "non_disponibile" } });
    expect((await businessesReply(q(T), rpc(null, { code: "22023" }))).status).toBe(400);
    expect((await businessesReply(q(T), rpc({ businesses: "no" }))).status).toBe(503);
    expect((await businessesReply(q(T), async () => { throw new Error("rete"); })).status).toBe(503);
  });

  it("foto: dal percorso nel bucket all'indirizzo pubblico, solo nella cartella del territorio", async () => {
    const id = "5e3a6059-2fff-4428-a351-8fa54b2725b2";
    const origin = "https://x.supabase.co";
    expect(businessPhotoUrl(`it.liguria.sp.portovenere/${id}/foto-ab12.jpg`, "it.liguria.sp.portovenere", origin))
      .toBe(`${origin}/storage/v1/object/public/business-photos/it.liguria.sp.portovenere/${id}/foto-ab12.jpg`);
    expect(businessPhotoUrl(`it.altro/${id}/foto.jpg`, "it.liguria.sp.portovenere", origin)).toBeNull();
    expect(businessPhotoUrl(`it.liguria.sp.portovenere/${id}/../x.jpg`, "it.liguria.sp.portovenere", origin)).toBeNull();
    expect(businessPhotoUrl(`it.liguria.sp.portovenere/${id}/foto.gif`, "it.liguria.sp.portovenere", origin)).toBeNull();
    const withPhotos = {
      territory: { id: "it.liguria.sp.portovenere" },
      businesses: [{ id: "a", name: "Bar", category: "bar", photos: [
        { path: `it.liguria.sp.portovenere/${id}/foto.jpg`, alt: "Bancone", author: "Mario", license: "cc0", originalUrl: null },
        { path: `it.altro/${id}/foto.jpg`, alt: "Altrove" },
      ] }],
    };
    const rpc: BusinessesRpc = async () => ({ data: withPhotos, error: null });
    const reply = await businessesReply(q(T), rpc, origin);
    const photos = (reply.body.businesses as { photos: Record<string, unknown>[] }[])[0]!.photos;
    expect(photos).toEqual([{ url: `${origin}/storage/v1/object/public/business-photos/it.liguria.sp.portovenere/${id}/foto.jpg`, alt: "Bancone", author: "Mario", license: "cc0", originalUrl: null }]);
    // Senza Supabase configurato nessuna foto (non c'è da dove leggerle).
    expect(((await businessesReply(q(T), rpc)).body.businesses as { photos: unknown[] }[])[0]!.photos).toEqual([]);
  });
});

describe("directory nella guida", () => {
  const data = parseBusinessesData(raw) as BusinessesData;

  it("scarta le schede malformate e i collegamenti non sicuri", () => {
    expect(data.businesses.map((b) => b.id)).toEqual(["a", "b", "c", "e"]);
    const c = data.businesses.find((b) => b.id === "c")!;
    expect(c.website).toBeNull();
    expect(c.phone).toBeNull();
    const e = data.businesses.find((b) => b.id === "e")!;
    expect(e.category).toBe("other");
    expect(e.location).toBeNull();
    expect(data.businesses[0]!.location).toEqual([9.835, 44.051]);
    expect(parseBusinessesData({ businesses: [] })).toBeNull();
  });

  it("foto: solo indirizzi https (o locali), testo alternativo obbligatorio, credito con la licenza che lo chiede", () => {
    const a = data.businesses.find((b) => b.id === "a")!;
    expect(a.photos).toEqual([
      { url: "https://x.supabase.co/storage/v1/object/public/business-photos/a.jpg", alt: "Il bancone", credit: "Mario Rossi · CC BY 4.0", originalUrl: null },
      { url: "https://x.supabase.co/b.jpg", alt: "Sala", credit: null, originalUrl: "https://commons.example.org/b" },
      { url: "http://localhost:54400/d.jpg", alt: "Locale", credit: "Anna", originalUrl: null },
    ]);
    expect(data.businesses.find((b) => b.id === "b")!.photos).toEqual([]);
  });

  it("stato: directory vuota o assente non si mostra, errori sì", () => {
    expect(businessesStateFromResponse(200, raw).kind).toBe("ok");
    expect(businessesStateFromResponse(200, { territory: { id: "x" }, businesses: [] }).kind).toBe("unavailable");
    expect(businessesStateFromResponse(404, null).kind).toBe("unavailable");
    expect(businessesStateFromResponse(503, { error: "non_configurato" }).kind).toBe("unavailable");
    expect(businessesStateFromResponse(503, { error: "non_disponibile" }).kind).toBe("error");
    expect(businessesStateFromResponse(200, { nope: true }).kind).toBe("error");
  });

  it("ordine neutrale: alfabetico senza posizione, per distanza con la posizione (senza coordinate in fondo)", () => {
    expect(listBusinesses(data, null, null).map((r) => r.business.id)).toEqual(["a", "b", "c", "e"]);
    const near = listBusinesses(data, null, [9.8400, 44.0600]);
    expect(near.map((r) => r.business.id)).toEqual(["c", "a", "b", "e"]);
    expect(near[0]!.distanceM).toBeLessThan(1);
    expect(near[2]!.distanceM).toBeNull();
    expect(listBusinesses(data, "bar", null).map((r) => r.business.id)).toEqual(["a"]);
    expect(businessCategoriesIn(data.businesses)).toEqual(["restaurant", "bar", "shop", "other"]);
  });

  it("orari solo con una verifica recente", () => {
    expect(hoursFresh("2026-10-01T10:00:00Z", now)).toBe(true);
    expect(hoursFresh(new Date(now - 181 * DAY).toISOString(), now)).toBe(false);
    expect(hoursFresh(null, now)).toBe(false);
    expect(hoursFresh("domani", now)).toBe(false);
    expect(hoursFresh(new Date(now + 2 * DAY).toISOString(), now)).toBe(false);
  });

  it("collegamenti e distanze", () => {
    expect(telHref("+39 0187 / 00.00-00")).toBe("tel:+390187000000");
    expect(distanceLabel(84, "it")).toBe("80 m");
    expect(distanceLabel(3, "it")).toBe("10 m");
    expect(distanceLabel(1430, "it")).toBe("1,4 km");
  });

  it("mappa delle attività: solo quelle con coordinate, nello stesso ordine dell'elenco", () => {
    const rows = listBusinesses(data, null, [9.8400, 44.0600]);
    expect(venueMarkers(rows).map((m) => m.id)).toEqual(["c", "a"]);
    expect(venueMarkers(rows)[0]).toEqual({ id: "c", name: "Trattoria Lontana", location: [9.84, 44.06], category: "restaurant" });
    expect(venueMarkers(listBusinesses(data, "shop", null))).toEqual([]);
  });

  it("modalità di esplorazione: solo i due valori previsti, «Storia e cultura» di base", () => {
    expect(parseExploreTheme("venues")).toBe("venues");
    expect(parseExploreTheme("culture")).toBe("culture");
    expect(parseExploreTheme("admin")).toBe("culture");
    expect(parseExploreTheme(null)).toBe("culture");
  });
});
