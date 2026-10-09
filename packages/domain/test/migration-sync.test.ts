import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PREDICATES } from "../src/ontology.ts";
import {
  ASSERTION_TYPES,
  CERTAINTY_LEVELS,
  COORDINATE_STATUSES,
  EVIDENCE_ATTRIBUTIONS,
  LICENSE_RULES,
  MEDIA_LICENSES,
  MEDIA_SOURCES,
  NODE_KINDS,
  QUALITY_TIERS,
  RELEASE_STAGES,
  ROUTE_CALIBRATIONS,
  ROUTE_DIFFICULTIES,
  UNIT_TYPES,
} from "../src/vocabulary.ts";

/**
 * Il database e il codice devono condividere lo stesso vocabolario.
 * Questo test fallisce se si aggiunge un valore da una parte sola.
 */
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../../../supabase/migrations");
const sql = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
  .join("\n");

/** Valori di un enum: la create type iniziale più gli "alter type … add value" successivi. */
function sqlEnum(name: string): string[] {
  const match = new RegExp(`create type ${name} as enum \\(([^)]*)\\)`, "i").exec(sql);
  if (!match) throw new Error(`enum ${name} non trovato nelle migrazioni`);
  const values = [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  const added = new RegExp(`alter type ${name} add value '([^']+)'(?: (before|after) '([^']+)')?`, "gi");
  for (const m of sql.matchAll(added)) {
    const [, value, where, other] = m;
    const at = where ? values.indexOf(other!) + (where.toLowerCase() === "after" ? 1 : 0) : values.length;
    values.splice(at, 0, value!);
  }
  return values;
}

describe("allineamento codice ↔ database", () => {
  it.each([
    ["node_kind", NODE_KINDS],
    ["assertion_type", ASSERTION_TYPES],
    ["certainty_level", CERTAINTY_LEVELS],
    ["quality_tier", QUALITY_TIERS],
    ["unit_type", UNIT_TYPES],
    ["media_source", MEDIA_SOURCES],
    ["media_license", MEDIA_LICENSES],
    ["coordinate_status", COORDINATE_STATUSES],
    ["evidence_attribution", EVIDENCE_ATTRIBUTIONS],
    ["release_stage", RELEASE_STAGES],
    ["route_difficulty", ROUTE_DIFFICULTIES],
    ["route_calibration", ROUTE_CALIBRATIONS],
  ])("enum %s", (name, values) => {
    expect(sqlEnum(name)).toEqual([...values]);
  });

  it("regole delle licenze", () => {
    const insert = /insert into media_license_rules values([\s\S]*?);/i.exec(sql)?.[1] ?? "";
    const rows = [...insert.matchAll(/\('([^']+)',\s*(true|false),\s*(true|false)\)/g)].map((m) => [m[1], m[2] === "true", m[3] === "true"]);
    expect(rows).toEqual(Object.entries(LICENSE_RULES).map(([k, v]) => [k, v.commercialUse, v.attributionRequired]));
  });

  it("predicati dell'ontologia", () => {
    const insert = /insert into predicates[\s\S]*?;/i.exec(sql)?.[0] ?? "";
    const ids = [...insert.matchAll(/\(\s*'([a-z_]+)',\s*'(relation|value|statement)'/g)].map((m) => [m[1], m[2]]);
    expect(ids).toEqual(PREDICATES.map((p) => [p.id, p.kind]));
  });
});
