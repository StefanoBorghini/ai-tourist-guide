import { describe, expect, it } from "vitest";
import {
  businessPayloadFromForm, formValuesFromBusiness, inBusinessView, needsReverify, type StudioBusiness,
} from "../lib/studio/local-businesses.ts";

const L = ["it", "en"];
const base = { name: " Bar Alba ", category: "bar" };
const DAY = 86_400_000;
const now = Date.parse("2026-10-28T10:00:00Z");

describe("modulo dell'attività nello Studio", () => {
  it("nome e categoria obbligatori; testi per lingua, vuoti tolti", () => {
    const r = businessPayloadFromForm({ ...base, description_it: "Caffè sul molo", hours_en: "7am–8pm", description_en: " " }, L);
    expect(r).toEqual({
      ok: true,
      payload: {
        name: "Bar Alba", category: "bar", subcategory: null,
        labels: { it: { description: "Caffè sul molo" }, en: { hours: "7am–8pm" } },
        address: null, lat: null, lng: null, phone: null, email: null, website: null,
      },
    });
    expect(businessPayloadFromForm({ category: "bar" }, L).ok).toBe(false);
    expect(businessPayloadFromForm({ name: "X", category: "casinò" }, L).ok).toBe(false);
  });

  it("recapiti e coordinate: forme plausibili, sito solo https", () => {
    const ok = businessPayloadFromForm({ ...base, phone: "+39 0187 000000", email: "info@bar.example.it", website: "https://bar.example.it", lat: "44,05", lng: "9.83" }, L);
    expect(ok).toMatchObject({ ok: true, payload: { lat: 44.05, lng: 9.83, website: "https://bar.example.it/" } });
    const bads: Record<string, string>[] = [{ phone: "chiamami" }, { email: "senza" }, { website: "http://bar.example.it" }, { lat: "44" }, { lat: "144", lng: "9" }, { slug: "Con Spazi" }];
    for (const bad of bads) {
      expect(businessPayloadFromForm({ ...base, ...bad }, L).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("andata e ritorno tra attività e modulo", () => {
    const b: StudioBusiness = {
      id: "1", pack: "p", slug: "bar-alba", name: "Bar Alba", category: "bar", subcategory: "caffè",
      labels: { it: { description: "Caffè", hours: "7–20" } }, address: "Molo 1", lat: 44.05, lng: 9.83,
      phone: "+39 0187 000000", email: null, website: null, publication: "draft", verifiedAt: null, verifiedBy: null,
      verificationNote: null, createdAt: "", updatedAt: "", publishedAt: null,
    };
    const v = formValuesFromBusiness(b, L);
    expect(v).toMatchObject({ name: "Bar Alba", lat: "44.05", description_it: "Caffè", hours_it: "7–20", description_en: "" });
    expect(businessPayloadFromForm(v, L)).toMatchObject({ ok: true, payload: { name: "Bar Alba", subcategory: "caffè", lat: 44.05, phone: "+39 0187 000000" } });
  });

  it("viste: da riverificare = pubblicate con verifica assente o oltre 180 giorni", () => {
    const fresh = { publication: "published" as const, verifiedAt: new Date(now - 10 * DAY).toISOString() };
    const old = { publication: "published" as const, verifiedAt: new Date(now - 200 * DAY).toISOString() };
    expect(needsReverify(fresh, now)).toBe(false);
    expect(needsReverify(old, now)).toBe(true);
    expect(inBusinessView(old, "da-riverificare", now)).toBe(true);
    expect(inBusinessView(fresh, "da-riverificare", now)).toBe(false);
    expect(inBusinessView({ publication: "draft", verifiedAt: null }, "da-riverificare", now)).toBe(false);
    expect(inBusinessView({ publication: "draft", verifiedAt: null }, "bozze", now)).toBe(true);
  });
});
