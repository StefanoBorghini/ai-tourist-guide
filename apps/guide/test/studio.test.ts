import { describe, expect, it } from "vitest";
import { checkImage, checkStops, friendlyError, MAX_IMAGE_BYTES, moveStop, readStudioConfig, storageFileName } from "../lib/studio/shared";

describe("configurazione dello Studio", () => {
  it("senza variabili lo Studio è spento (la guida no)", () => {
    expect(readStudioConfig({})).toBeNull();
    expect(readStudioConfig({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" })).toBeNull();
  });
  it("accetta solo un indirizzo https senza percorso", () => {
    expect(readStudioConfig({ NEXT_PUBLIC_SUPABASE_URL: "http://x.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" })).toBeNull();
    expect(readStudioConfig({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co/", NEXT_PUBLIC_SUPABASE_ANON_KEY: " k " })).toEqual({
      url: "https://x.supabase.co",
      anonKey: "k",
    });
  });
});

describe("foto", () => {
  it("solo JPEG, PNG e WebP entro il limite", () => {
    expect(checkImage({ type: "image/jpeg", size: 1000 })).toBeNull();
    expect(checkImage({ type: "image/gif", size: 1000 })).toMatch(/Formato/);
    expect(checkImage({ type: "image/png", size: MAX_IMAGE_BYTES + 1 })).toMatch(/supera/);
    expect(checkImage({ type: "image/webp", size: 0 })).toMatch(/vuoto/);
  });
  it("nome nel bucket pulito, con suffisso ed estensione dal tipo reale", () => {
    expect(storageFileName("Chiesa di San Pietro (2).JPEG", "image/jpeg", "abc")).toBe("chiesa-di-san-pietro-2-abc.jpg");
    expect(storageFileName("Città è bella.png", "image/png", "x1")).toBe("citta-e-bella-x1.png");
    expect(storageFileName("....webp", "image/webp", "z")).toBe("immagine-z.webp");
    expect(storageFileName("../../etc/passwd.jpg", "image/jpeg", "z")).toMatch(/^[a-z0-9-]+\.jpg$/);
  });
});

describe("tappe", () => {
  const stops = ["a", "b", "c"];
  it("sposta su e giù senza uscire dai limiti", () => {
    expect(moveStop(stops, 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveStop(stops, 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveStop(stops, 0, -1)).toEqual(stops);
    expect(moveStop(stops, 2, 1)).toEqual(stops);
    expect(moveStop(stops, 1, -1)).not.toBe(stops);
  });
  it("almeno una tappa, nessun doppione, soste valide", () => {
    expect(checkStops([])).toMatch(/almeno una/);
    expect(checkStops([{ place: "x", dwellMin: null }, { place: "x", dwellMin: 5 }])).toMatch(/due volte/);
    expect(checkStops([{ place: "x", dwellMin: 0 }])).toMatch(/sosta/i);
    expect(checkStops([{ place: "x", dwellMin: 2.5 }])).toMatch(/sosta/i);
    expect(checkStops([{ place: "x", dwellMin: null }, { place: "y", dwellMin: 240 }])).toBeNull();
  });
});

describe("messaggi d'errore", () => {
  it("mostra i messaggi del database scritti per le persone, non quelli tecnici", () => {
    expect(friendlyError({ message: "regola dei quattro occhi: chi ha scritto l'affermazione non può verificarla" })).toMatch(/quattro occhi/);
    expect(friendlyError({ message: 'null value in column "x" violates not-null constraint' })).toMatch(/non riuscita/);
    expect(friendlyError({ message: "JWT expired", code: "PGRST301" })).toMatch(/sessione/);
    expect(friendlyError(null)).toMatch(/non riuscita/);
  });
});

describe("configurazione locale", () => {
  it("http è ammesso solo per localhost", () => {
    expect(readStudioConfig({ NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54400", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" })).not.toBeNull();
    expect(readStudioConfig({ NEXT_PUBLIC_SUPABASE_URL: "http://localhost.evil.com", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" })).toBeNull();
  });
});

describe("nuovo territorio", () => {
  it("propone l'identificativo dal territorio che lo contiene e dal nome", async () => {
    const { suggestPackId, PACK_ID_RE, withinScopes } = await import("../lib/studio/shared");
    expect(suggestPackId("it.liguria.sp", "Lerici & San Terenzo")).toBe("it.liguria.sp.lerici-san-terenzo");
    expect(suggestPackId("", "Cinque Terre")).toBe("cinque-terre");
    expect(PACK_ID_RE.test("it.liguria.sp.lerici")).toBe(true);
    expect(PACK_ID_RE.test("it.Liguria")).toBe(false);
    expect(withinScopes("it.liguria.sp.lerici", false, ["it.liguria"])).toBe(true);
    expect(withinScopes("it.liguriax", false, ["it.liguria"])).toBe(false);
    expect(withinScopes("fr.nice", true, [])).toBe(true);
  });
});
