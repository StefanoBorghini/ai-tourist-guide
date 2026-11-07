import { describe, expect, it } from "vitest";
import { canShareFile, instagramOf, isMobileUa, placeFromParam, placeParam, placeShareUrl, profileUrl, shareCaption } from "../lib/share-instagram.ts";

const ig = { handle: "portovenere_com", hashtags: ["Portovenere"] };

describe("invito a condividere su Instagram", () => {
  it("legge la configurazione del bundle e ignora quella non valida", () => {
    expect(instagramOf({ social: { instagram: ig } })).toEqual(ig);
    expect(instagramOf({})).toBeNull();
    expect(instagramOf({ social: {} })).toBeNull();
    expect(instagramOf({ social: { instagram: { handle: "@con spazio" } } })).toBeNull();
    expect(instagramOf({ social: { instagram: { handle: "ok", hashtags: ["Buono", "#cattivo", "con spazio", 3, "a", "b", "c", "d", "e"] } } }))
      .toEqual({ handle: "ok", hashtags: ["Buono", "a", "b", "c", "d"] });
  });

  it("testo: luogo, destinazione se diversa, account e hashtag; niente link", () => {
    expect(shareCaption(ig, "Castello Doria", "Portovenere")).toBe("📍 Castello Doria · Portovenere\n@portovenere_com #Portovenere");
    expect(shareCaption(ig, "Portovenere", "Portovenere")).toBe("📍 Portovenere\n@portovenere_com #Portovenere");
    expect(shareCaption({ handle: "a", hashtags: [] }, "Torre", "Borgo")).toBe("📍 Torre · Borgo\n@a");
  });

  it("profilo con il collegamento ufficiale", () => {
    expect(profileUrl("portovenere_com")).toBe("https://www.instagram.com/portovenere_com/");
  });

  it("collegamento al luogo: slug per i luoghi della destinazione, riferimento completo per gli altri", () => {
    const d = "it.liguria.sp.portovenere";
    expect(placeParam(`${d}:castello-doria`, d)).toBe("castello-doria");
    expect(placeParam("it.liguria:palmaria", d)).toBe("it.liguria:palmaria");
    const refs = [`${d}:castello-doria`, "it.liguria:palmaria"];
    expect(placeFromParam("castello-doria", d, refs)).toBe(`${d}:castello-doria`);
    expect(placeFromParam("it.liguria:palmaria", d, refs)).toBe("it.liguria:palmaria");
    expect(placeFromParam("nessuno", d, refs)).toBeNull();
    expect(placeFromParam("../x", d, refs)).toBeNull();
    expect(placeFromParam(null, d, refs)).toBeNull();
    expect(placeShareUrl("https://guida.example", "/", d, `${d}:castello-doria`)).toBe(
      "https://guida.example/?d=it.liguria.sp.portovenere&p=castello-doria",
    );
  });

  it("condivisione di file solo se il browser la offre", () => {
    const f = new File(["x"], "a.jpg", { type: "image/jpeg" });
    expect(canShareFile({ canShare: () => true }, f)).toBe(true);
    expect(canShareFile({ canShare: () => false }, f)).toBe(false);
    expect(canShareFile({}, f)).toBe(false);
    expect(canShareFile({ canShare: () => { throw new Error("no"); } }, f)).toBe(false);
    expect(canShareFile(undefined, f)).toBe(false);
  });

  it("telefono o computer", () => {
    expect(isMobileUa("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe(true);
    expect(isMobileUa("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe(true);
    expect(isMobileUa("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(false);
  });
});
