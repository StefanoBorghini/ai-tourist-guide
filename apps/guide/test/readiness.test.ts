import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPacks, packToSnapshot } from "@guide/territory-pack";
import { describe, expect, it } from "vitest";
import { assessReadiness } from "../lib/studio/readiness";

const here = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC = resolve(here, "../../../territories/_synthetic");
const files = () => ({ sha256: "0".repeat(64), bytes: 1 });
const json = (x: unknown) => JSON.parse(JSON.stringify(x)) as Record<string, unknown>;

/** Un territorio come lo crea lo Studio: una destinazione di ricerca con un luogo, una fonte, un fatto e un racconto. */
function newDestination(overrides: Record<string, unknown> = {}) {
  return json({
    manifest: {
      schemaVersion: 1, id: "zz.nuovo-borgo", kind: "destination", version: "0.1.0", name: { it: "Nuovo borgo", en: "New village" },
      defaultLocale: "it", locales: ["it", "en"], qualityTier: "silver", dependsOn: [], fictional: false, releaseStage: "research",
    },
    config: {},
    places: [{
      id: "piazza", placeKind: "poi", categories: ["piazza"], location: [9.9, 44.1], importance: 3, dwellMin: 10,
      labels: { it: { name: "Piazza" }, en: { name: "Square" } }, geofences: [{ kind: "arrival", radiusM: 40 }],
      coordinates: { status: "preliminary", method: "GPS" }, practical: [],
    }],
    sources: [{ id: "archivio", sourceKind: "archive_document", title: "Archivio", reliability: "A" }],
    assertions: [{
      id: "fontana", subject: "zz.nuovo-borgo:piazza", predicate: "described_as", type: "fact", certainty: "established",
      status: "in_review", texts: { it: "La fontana è del 1890.", en: "The fountain dates from 1890." },
      evidence: [{ source: "zz.nuovo-borgo:archivio", locator: "p. 4" }], authoredBy: "studio",
    }],
    units: [
      { id: "piazza-it", anchor: "zz.nuovo-borgo:piazza", unitType: "opening", locale: "it", durationS: 20, text: "La fontana è del 1890.", assertions: ["fontana"] },
      { id: "piazza-en", anchor: "zz.nuovo-borgo:piazza", unitType: "opening", locale: "en", durationS: 20, text: "The fountain dates from 1890.", assertions: ["fontana"] },
    ],
    routes: [], anchors: [], nodes: [], media: [],
    ...overrides,
  });
}

describe("controllo di pubblicazione", () => {
  it("un territorio con luogo, fonte, fatto in revisione e racconti è pronto (anteprima di ricerca)", () => {
    const r = assessReadiness("zz.nuovo-borgo", new Map([["zz.nuovo-borgo", newDestination()]]), new Set());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.bundles.map((b) => [b.locale, b.places, b.units, b.preview])).toEqual([["it", 1, 1, true], ["en", 1, 1, true]]);
  });

  it("un territorio vuoto non è pronto", () => {
    const r = assessReadiness("zz.nuovo-borgo", new Map([["zz.nuovo-borgo", newDestination({ places: [], assertions: [], units: [], sources: [] })]]), new Set());
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain("NO_PLACES");
  });

  it("un racconto legato a una bozza non è raccontabile: errore del validatore", () => {
    const snap = newDestination();
    (snap.assertions as Record<string, unknown>[])[0]!.status = "draft";
    const r = assessReadiness("zz.nuovo-borgo", new Map([["zz.nuovo-borgo", snap]]), new Set());
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain("UNIT_ASSERTION_NOT_NARRATABLE");
  });

  it("i file media devono essere nel bucket, non su disco", () => {
    const { packs } = loadPacks(SYNTHETIC);
    const snaps = new Map([...packs].map(([id, p]) => [id, json(packToSnapshot(p, files))]));
    const missing = assessReadiness("it.test.borgo-di-prova", snaps, new Set());
    expect(missing.errors.filter((e) => e.code === "MEDIA_NOT_IN_STORAGE").length).toBeGreaterThan(0);
    expect(missing.errors.map((e) => e.code)).not.toContain("MEDIA_FILE_MISSING");
    const stored = new Set(packs.get("it.test.borgo-di-prova")!.media.flatMap((m) => [m.file, ...(m.poster ? [m.poster] : [])]).map((f) => `it.test.borgo-di-prova/${f}`));
    const present = assessReadiness("it.test.borgo-di-prova", snaps, stored);
    expect(present.errors.map((e) => e.code)).not.toContain("MEDIA_NOT_IN_STORAGE");
    // È un territorio fittizio: si controlla ma non si pubblica.
    expect(present.errors.map((e) => e.code)).toContain("FICTIONAL");
  });

  it("una dipendenza non leggibile blocca la pubblicazione con un messaggio chiaro", () => {
    const snap = newDestination();
    (snap.manifest as Record<string, unknown>).dependsOn = ["zz"];
    const r = assessReadiness("zz.nuovo-borgo", new Map<string, Record<string, unknown> | null>([["zz.nuovo-borgo", snap], ["zz", null]]), new Set());
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain("DEPENDENCY_UNREADABLE");
  });

  it("una regione è un contenitore: nessun bundle, solo un avviso", () => {
    const snap = newDestination();
    (snap.manifest as Record<string, unknown>).kind = "region";
    const r = assessReadiness("zz.nuovo-borgo", new Map([["zz.nuovo-borgo", snap]]), new Set());
    expect(r.bundles).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toContain("CONTAINER");
  });
});
