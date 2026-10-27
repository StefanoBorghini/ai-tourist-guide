import { describe, expect, it } from "vitest";
import { practicalInfoSchema } from "@guide/domain";
import { applyPracticalChange, isExpired, newPracticalId, parsePracticalForm, validUntil, type PracticalItem } from "../lib/studio/practical.ts";

const TODAY = "2026-10-27";
const form = (values: Record<string, string>) => (name: string) => values[name] ?? "";
const base = { kind: "opening_hours", text_it: "  Aperta   dalle 9 alle 18. ", text_en: "", checkedAt: "2026-10-20", recheckAfterDays: "60", source: "parco" };

describe("informazioni pratiche nello Studio", () => {
  it("dal modulo all'elemento nel formato del Territory Pack", () => {
    const r = parsePracticalForm(form(base), "orari", TODAY);
    expect(r).toEqual({ ok: true, item: { id: "orari", kind: "opening_hours", text: { it: "Aperta dalle 9 alle 18." }, checkedAt: "2026-10-20", recheckAfterDays: 60, source: "parco" } });
    // Lo stesso formato che il validatore dei pack accetta.
    if (r.ok) expect(practicalInfoSchema.safeParse(r.item).success).toBe(true);
    const noSource = parsePracticalForm(form({ ...base, source: "", recheckAfterDays: "" }), "orari", TODAY);
    expect(noSource).toMatchObject({ ok: true, item: { recheckAfterDays: 90 } });
    if (noSource.ok) expect(noSource.item).not.toHaveProperty("source");
  });

  it("messaggi chiari per i dati mancanti o sbagliati", () => {
    expect(parsePracticalForm(form({ ...base, kind: "meteo" }), "x", TODAY)).toEqual({ ok: false, error: "Scegli il tipo di informazione." });
    expect(parsePracticalForm(form({ ...base, text_it: " " }), "x", TODAY)).toEqual({ ok: false, error: "Scrivi il testo in italiano." });
    expect(parsePracticalForm(form({ ...base, checkedAt: "27/10/2026" }), "x", TODAY)).toMatchObject({ ok: false });
    expect(parsePracticalForm(form({ ...base, checkedAt: "2026-10-28" }), "x", TODAY)).toEqual({ ok: false, error: "La data del controllo non può essere nel futuro." });
    expect(parsePracticalForm(form({ ...base, recheckAfterDays: "0" }), "x", TODAY)).toMatchObject({ ok: false });
    expect(parsePracticalForm(form({ ...base, recheckAfterDays: "731" }), "x", TODAY)).toMatchObject({ ok: false });
    expect(parsePracticalForm(form({ ...base, text_it: "x".repeat(601) }), "x", TODAY)).toMatchObject({ ok: false });
  });

  it("identificativi nuovi e unici dal tipo", () => {
    const items = [{ id: "opening-hours" }, { id: "opening-hours-2" }] as PracticalItem[];
    expect(newPracticalId("access", items)).toBe("access");
    expect(newPracticalId("opening_hours", items)).toBe("opening-hours-3");
  });

  it("validità: fino a checkedAt + recheckAfterDays, poi scaduta", () => {
    const item = { checkedAt: "2026-10-01", recheckAfterDays: 30 };
    expect(validUntil(item)).toBe("2026-10-31");
    expect(isExpired(item, "2026-10-31")).toBe(false);
    expect(isExpired(item, "2026-11-01")).toBe(true);
  });

  it("aggiunta, modifica al suo posto e rimozione", () => {
    const a = { id: "a", kind: "access", text: { it: "A" }, checkedAt: TODAY, recheckAfterDays: 90 } as PracticalItem;
    const b = { ...a, id: "b", text: { it: "B" } };
    const added = applyPracticalChange([a], { op: "add", item: b });
    expect(added).toEqual({ ok: true, items: [a, b] });
    expect(applyPracticalChange([a, b], { op: "update", item: { ...a, text: { it: "A2" } } })).toEqual({ ok: true, items: [{ ...a, text: { it: "A2" } }, b] });
    expect(applyPracticalChange([a, b], { op: "delete", id: "a" })).toEqual({ ok: true, items: [b] });
    expect(applyPracticalChange([a], { op: "add", item: a })).toMatchObject({ ok: false });
    expect(applyPracticalChange([a], { op: "delete", id: "z" })).toMatchObject({ ok: false });
    expect(applyPracticalChange([a], { op: "update", item: b })).toMatchObject({ ok: false });
    const full = Array.from({ length: 30 }, (_, i) => ({ ...a, id: `p${i}` }));
    expect(applyPracticalChange(full, { op: "add", item: b })).toMatchObject({ ok: false });
  });
});
