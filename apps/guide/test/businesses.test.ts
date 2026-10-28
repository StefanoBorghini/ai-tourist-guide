import { describe, expect, it } from "vitest";
import { businessesReply, businessesRpcArgs, parseBusinessesQuery, type BusinessesRpc } from "../lib/businesses-api.ts";
import { NO_STORE, PUBLIC_CACHE } from "../lib/events-api.ts";
import {
  businessCategoriesIn, businessesStateFromResponse, directionsHref, distanceLabel, hoursFresh, listBusinesses, parseBusinessesData, telHref,
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
    { id: "a", name: "Bar Alba", category: "bar", subcategory: "caffè", lat: 44.0510, lng: 9.8350, phone: "+39 0187 000000", verifiedAt: "2026-10-01T10:00:00Z", hours: "7–20" },
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
    expect(directionsHref({ name: "Bar", address: null, location: [9.835, 44.051] })).toBe("https://www.google.com/maps/dir/?api=1&destination=44.051%2C9.835");
    expect(directionsHref({ name: "Bar", address: "Via Roma 1", location: null })).toContain("destination=Bar%2C+Via+Roma+1");
    expect(directionsHref({ name: "Bar", address: null, location: null })).toBeNull();
    expect(distanceLabel(84, "it")).toBe("80 m");
    expect(distanceLabel(3, "it")).toBe("10 m");
    expect(distanceLabel(1430, "it")).toBe("1,4 km");
  });
});
