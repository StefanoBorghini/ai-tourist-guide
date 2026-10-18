import { describe, expect, it } from "vitest";
import { missingParts, offlineUntil, premiumEntries, premiumTarget, reconcile, usableParts, type StoredPremium } from "../lib/premium";

const PUB = "0a0b0c0d-0000-4000-8000-000000000001";
const URL_IT = `/pub/zz.borgo/it-full/${PUB}/manifest.json`;
const file = (name: string, sha = "a".repeat(64), pack = "zz.borgo", locale = "it", pub = PUB) =>
  ({ kind: name.startsWith("route") ? "route" as const : "explore" as const, path: `${pack}/${locale}/${pub}/${name}.${sha.slice(0, 16)}.json`, sha256: sha, bytes: 10 });

describe("consegna dei contenuti acquistati", () => {
  it("si accettano solo manifest di una pubblicazione dello Studio", () => {
    expect(premiumTarget(URL_IT)).toEqual({ pack: "zz.borgo", locale: "it", publication: PUB });
    for (const bad of [null, "/pub/zz.borgo/it-full/manifest.json", `/pub/../it-full/${PUB}/manifest.json`, `https://altro.sito/pub/zz.borgo/it-full/${PUB}/manifest.json`, `/bundles/zz.borgo/it-full/${PUB}/manifest.json`]) {
      expect(premiumTarget(bad)).toBeNull();
    }
  });

  it("dal manifest solo i file della sua cartella, della sua destinazione e lingua", () => {
    const own = file("explore");
    const manifest = { destination: "zz.borgo", locale: "it" as const, premium: [own, file("explore", "b".repeat(64), "zz.altro"), file("route-giro", "c".repeat(64), "zz.borgo", "en"), file("explore", "d".repeat(64), "zz.borgo", "it", "0a0b0c0d-0000-4000-8000-000000000002")] };
    expect(premiumEntries(manifest, premiumTarget(URL_IT)!)).toEqual([own]);
    expect(premiumEntries({ ...manifest, destination: "zz.altro" }, premiumTarget(URL_IT)!)).toEqual([]);
  });

  it("senza rete le parti valgono 30 giorni dall'ultima convalida, solo per quel manifest", () => {
    const now = Date.UTC(2026, 9, 18);
    const stored: StoredPremium = { manifest: URL_IT, validUntil: offlineUntil(now), parts: [{ entry: file("explore"), json: "{}" }] };
    expect(usableParts(stored, URL_IT, now + 29 * 86_400_000)).toHaveLength(1);
    expect(usableParts(stored, URL_IT, now + 30 * 86_400_000)).toHaveLength(0);
    expect(usableParts(stored, URL_IT.replace(PUB, "0a0b0c0d-0000-4000-8000-000000000002"), now)).toHaveLength(0);
  });

  it("alla convalida si tengono solo le parti ancora concesse (rimborso: si cancellano) e la scadenza riparte", () => {
    const explore = file("explore");
    const route = file("route-giro", "c".repeat(64));
    const stored: StoredPremium = { manifest: URL_IT, validUntil: 1, parts: [{ entry: explore, json: "{}" }, { entry: route, json: "{}" }] };
    const after = reconcile(stored, URL_IT, [explore], 999);
    expect(after.parts.map((p) => p.entry.path)).toEqual([explore.path]);
    expect(after.validUntil).toBe(999);
    expect(reconcile(stored, URL_IT, [], 999).parts).toEqual([]);
    // Nuova pubblicazione: la copia della precedente non vale più.
    expect(reconcile(stored, URL_IT.replace(PUB, "0a0b0c0d-0000-4000-8000-000000000002"), [explore], 999).parts).toEqual([]);
    expect(missingParts(after, [explore, route])).toEqual([route]);
  });
});
