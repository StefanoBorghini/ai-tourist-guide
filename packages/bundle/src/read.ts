import type { EngineInputs } from "@guide/context-engine";
import type { LibraryUnit, NarrativeLibrary } from "@guide/narrative-planner";
import { BUNDLE_SCHEMA_VERSION, type BundleContent, type BundleManifest } from "./format.ts";

/**
 * Lettura di un bundle sul dispositivo: verifica l'integrità e prepara gli
 * input per il motore di contesto e il pianificatore narrativo.
 * L'app funziona con il solo bundle: niente database, niente rete.
 */

export class BundleIntegrityError extends Error {
  override name = "BundleIntegrityError";
}

async function sha256Hex(data: string): Promise<string> {
  // Web Crypto: disponibile nei browser e in Node 22, quindi lo stesso codice gira sul telefono.
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Verifica versione e hash del contenuto rispetto al manifest. */
export async function verifyBundle(manifest: BundleManifest, contentJson: string): Promise<BundleContent> {
  if (manifest.bundleSchemaVersion !== BUNDLE_SCHEMA_VERSION) {
    throw new BundleIntegrityError(`versione del bundle non supportata: ${manifest.bundleSchemaVersion}`);
  }
  const entry = manifest.files.find((f) => f.path === manifest.content);
  if (!entry) throw new BundleIntegrityError("il manifest non elenca il file dei contenuti");
  const hash = await sha256Hex(contentJson);
  if (hash !== entry.sha256) throw new BundleIntegrityError("contenuto corrotto o non corrispondente al manifest");
  const content = JSON.parse(contentJson) as BundleContent;
  if (content.destination !== manifest.destination || content.locale !== manifest.locale) {
    throw new BundleIntegrityError("contenuto di un'altra destinazione o lingua");
  }
  return content;
}

/** Libreria narrativa dal bundle (stessa struttura di quella costruita dai pack). */
export function libraryFromBundle(content: BundleContent): NarrativeLibrary {
  const lib: NarrativeLibrary = {
    destination: content.destination,
    units: new Map(),
    byAnchor: new Map(),
    introducers: new Map(),
    labels: new Map(),
  };
  for (const item of [...content.places, ...content.nodes]) lib.labels.set(item.ref, { [content.locale]: item.name });
  for (const u of content.units) {
    const unit: LibraryUnit = {
      ref: u.ref,
      anchor: u.anchor,
      unitType: u.unitType,
      locale: content.locale,
      audience: u.audience,
      durationS: u.durationS,
      text: u.text,
      assertions: u.assertions,
      introduces: u.introduces,
      requires: u.requires,
      hooks: u.hooks,
      resumeHook: u.resumeHook,
    };
    lib.units.set(unit.ref, unit);
    lib.byAnchor.set(unit.anchor, [...(lib.byAnchor.get(unit.anchor) ?? []), unit]);
    for (const c of unit.introduces) {
      const key = `${content.locale}|${c}`;
      lib.introducers.set(key, [...(lib.introducers.get(key) ?? []), unit]);
    }
  }
  return lib;
}

/** Input del motore di contesto dal bundle. Gli id dei luoghi sono i riferimenti completi. */
export function engineInputsFromBundle(content: BundleContent): EngineInputs {
  return {
    places: content.places.map((p) => ({
      id: p.ref,
      location: p.location,
      elevationM: p.elevationM,
      importance: p.importance,
      dwellMin: p.dwellMin,
      tags: p.categories,
      stepFree: p.stepFree,
      stairs: p.stairs,
      walkable: p.walkable,
    })),
    fences: content.places.flatMap((p) =>
      p.geofences.map((g, i) => ({
        id: `${p.ref}#${g.kind}#${i}`,
        placeId: p.ref,
        kind: g.kind,
        center: g.center,
        radiusM: g.radiusM,
        minDwellS: g.minDwellS,
        maxAccuracyM: g.maxAccuracyM,
        viewBearingDeg: g.viewBearingDeg,
        viewToleranceDeg: g.viewToleranceDeg,
      })),
    ),
    anchors: content.anchors.map((a) => ({ id: a.ref, location: a.location, safetyMarginMin: a.safetyMarginMin })),
  };
}
