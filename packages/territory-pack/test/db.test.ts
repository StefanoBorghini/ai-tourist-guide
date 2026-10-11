import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TerritoryPack } from "@guide/domain";
import { describe, expect, it } from "vitest";
import { diffPacks, importSql, packToSnapshot, SnapshotError, snapshotToPack, writePackDir } from "../src/db.ts";
import { loadPacks } from "../src/load.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_ROOT = resolve(here, "../../../territories/_synthetic");
const VILLAGE = "it.test.borgo-di-prova";
const files = () => ({ sha256: "0".repeat(64), bytes: 100 });

function village(): TerritoryPack {
  const { packs, issues } = loadPacks(SYNTHETIC_ROOT);
  expect(issues).toEqual([]);
  return structuredClone(packs.get(VILLAGE)!);
}

/** Come farebbe il database: JSON, chiavi e valori senza tipi TypeScript. */
const viaJson = (x: unknown) => JSON.parse(JSON.stringify(x)) as Record<string, unknown>;

describe("istantanea per il database", () => {
  it("andata e ritorno restituiscono lo stesso pack", () => {
    const pack = village();
    const back = snapshotToPack(viaJson(packToSnapshot(pack, files)), pack.dir);
    expect(diffPacks(pack, back)).toEqual([]);
  });

  it("nell'istantanea i riferimenti sono completi, nel pack riletto tornano locali", () => {
    const pack = village();
    const snap = viaJson(packToSnapshot(pack, files));
    const refs = (snap.assertions as { subject: string }[]).map((a) => a.subject);
    expect(refs.every((r) => r.includes(":"))).toBe(true);
    const back = snapshotToPack(snap, pack.dir);
    const local = back.assertions.find((a) => a.subject.startsWith(`${VILLAGE}:`));
    expect(local).toBeUndefined();
  });

  it("i media portano impronta, dimensione e tipo; il pack riletto no", () => {
    const pack = village();
    const snap = viaJson(packToSnapshot(pack, files));
    const media = (snap.media as Record<string, unknown>[])[0]!;
    expect(media).toMatchObject({ sha256: "0".repeat(64), bytes: 100 });
    expect(String(media.mimeType)).toMatch(/^(image|video)\//);
    expect(snapshotToPack(snap, pack.dir).media[0]).not.toHaveProperty("sha256");
  });

  it("un'istantanea non valida si rifiuta con l'elenco dei problemi", () => {
    const snap = viaJson(packToSnapshot(village(), files));
    (snap.places as Record<string, unknown>[])[0]!.importance = 9;
    expect(() => snapshotToPack(snap, "x")).toThrow(SnapshotError);
  });

  it("un cambiamento si vede nel confronto", () => {
    const pack = village();
    const back = snapshotToPack(viaJson(packToSnapshot(pack, files)), pack.dir);
    back.routes[0]!.stops.reverse();
    expect(diffPacks(pack, back).length).toBeGreaterThan(0);
  });

  it("l'SQL è un solo comando e il delimitatore non compare nel testo", () => {
    const snap = { manifest: { id: "x" }, note: "contiene $pack$ e $pack_$" };
    const sql = importSql(snap);
    expect(sql).toMatch(/^select import_pack\(\$pack__\$/);
    expect(sql.trim().split("\n")).toHaveLength(1);
  });

  it("scritto come YAML e ricaricato, il pack non cambia", () => {
    const pack = village();
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    try {
      writePackDir(pack, join(dir, VILLAGE));
      const reloaded = loadPacks(dir).packs.get(VILLAGE)!;
      expect(diffPacks(pack, reloaded)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
