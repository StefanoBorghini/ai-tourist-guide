import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { TerritoryPack } from "@guide/domain";
import { describe, expect, it } from "vitest";
import { loadPacks } from "../src/load.ts";
import { validatePacks } from "../src/validate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_ROOT = resolve(here, "../../../territories/_synthetic");
const AREA = "it.test";
const VILLAGE = "it.test.borgo-di-prova";

/** Carica i pack sintetici e restituisce una copia modificabile. */
function loadSynthetic(): Map<string, TerritoryPack> {
  const { packs, issues } = loadPacks(SYNTHETIC_ROOT);
  expect(issues).toEqual([]);
  return structuredClone(packs);
}

function village(packs: Map<string, TerritoryPack>): TerritoryPack {
  return packs.get(VILLAGE)!;
}

function errorCodes(packs: Map<string, TerritoryPack>): string[] {
  return validatePacks(packs)
    .filter((i) => i.level === "error")
    .map((i) => i.code);
}

function warningCodes(packs: Map<string, TerritoryPack>): string[] {
  return validatePacks(packs)
    .filter((i) => i.level === "warning")
    .map((i) => i.code);
}

describe("pack sintetici", () => {
  it("si caricano e sono validi", () => {
    const packs = loadSynthetic();
    expect([...packs.keys()].sort()).toEqual([AREA, VILLAGE]);
    expect(errorCodes(packs)).toEqual([]);
  });

  it("segnalano la bozza senza fonte solo come avviso", () => {
    expect(warningCodes(loadSynthetic())).toContain("EVIDENCE_REQUIRED");
  });
});

describe("dipendenze e riferimenti", () => {
  it("rifiuta un riferimento a un pack non dichiarato tra le dipendenze", () => {
    const packs = loadSynthetic();
    village(packs).manifest.dependsOn = [];
    expect(errorCodes(packs)).toContain("UNDECLARED_DEPENDENCY");
  });

  it("rifiuta un nodo inesistente", () => {
    const packs = loadSynthetic();
    village(packs).assertions[0]!.subject = "luogo-che-non-esiste";
    expect(errorCodes(packs)).toContain("UNRESOLVED_REF");
  });

  it("rifiuta una dipendenza mancante", () => {
    const packs = loadSynthetic();
    village(packs).manifest.dependsOn.push("it.inesistente");
    expect(errorCodes(packs)).toContain("DEPENDENCY_MISSING");
  });

  it("rileva le dipendenze circolari", () => {
    const packs = loadSynthetic();
    packs.get(AREA)!.manifest.dependsOn = [VILLAGE];
    expect(errorCodes(packs)).toContain("DEPENDENCY_CYCLE");
  });

  it("impedisce a un pack reale di dipendere da un pack fittizio", () => {
    const packs = loadSynthetic();
    village(packs).manifest.fictional = false;
    const codes = errorCodes(packs);
    expect(codes).toContain("FICTIONAL_DEPENDENCY");
    expect(codes).toContain("FICTIONAL_SOURCE");
  });

  it("rifiuta id duplicati tra luoghi e nodi", () => {
    const packs = loadSynthetic();
    const v = village(packs);
    v.nodes[0]!.id = v.places[0]!.id;
    expect(errorCodes(packs)).toContain("DUPLICATE_ID");
  });
});

describe("ontologia", () => {
  it("rifiuta un predicato sconosciuto", () => {
    const packs = loadSynthetic();
    village(packs).assertions[0]!.predicate = "inventato";
    expect(errorCodes(packs)).toContain("UNKNOWN_PREDICATE");
  });

  it("rifiuta un soggetto del tipo sbagliato", () => {
    const packs = loadSynthetic();
    // 'visited' vuole una persona come soggetto, non un luogo.
    const a = village(packs).assertions.find((x) => x.id === "ada-belvedere")!;
    a.subject = "torre-di-prova";
    expect(errorCodes(packs)).toContain("PREDICATE_DOMAIN");
  });

  it("rifiuta un oggetto del tipo sbagliato", () => {
    const packs = loadSynthetic();
    const a = village(packs).assertions.find((x) => x.id === "torre-controllo")!;
    a.object = "belvedere"; // controlled_by vuole un'organizzazione o una persona
    expect(errorCodes(packs)).toContain("PREDICATE_RANGE");
  });

  it("richiede un valore della forma giusta per gli attributi", () => {
    const packs = loadSynthetic();
    const a = village(packs).assertions.find((x) => x.id === "porta-larghezza")!;
    a.value = { yearFrom: 1200, circa: false };
    expect(errorCodes(packs)).toContain("VALUE_SHAPE");
  });
});

describe("verifica dei fatti", () => {
  it("applica la regola dei quattro occhi", () => {
    const packs = loadSynthetic();
    const a = village(packs).assertions[0]!;
    a.verifiedBy = a.authoredBy;
    expect(errorCodes(packs)).toContain("FOUR_EYES");
  });

  it("richiede una fonte per le affermazioni non in bozza", () => {
    const packs = loadSynthetic();
    village(packs).assertions[0]!.evidence = [];
    expect(errorCodes(packs)).toContain("EVIDENCE_REQUIRED");
  });

  it("richiede la certezza per i fatti", () => {
    const packs = loadSynthetic();
    delete village(packs).assertions[0]!.certainty;
    expect(errorCodes(packs)).toContain("CERTAINTY_REQUIRED");
  });

  it("richiede almeno due alternative in una controversia", () => {
    const packs = loadSynthetic();
    const v = village(packs);
    v.assertions = v.assertions.filter((a) => a.id !== "chiesa-datazione-b");
    v.units = v.units.filter((u) => u.id !== "chiesa-datazione-it");
    expect(errorCodes(packs)).toContain("DISPUTE_SINGLE");
  });

  it("richiede type legend per il contenuto di una leggenda", () => {
    const packs = loadSynthetic();
    const a = village(packs).assertions.find((x) => x.id === "sirena-racconto")!;
    a.type = "fact";
    a.certainty = "established";
    expect(errorCodes(packs)).toContain("LEGEND_TYPE");
  });
});

describe("narrazione", () => {
  it("non permette di raccontare affermazioni non verificate", () => {
    const packs = loadSynthetic();
    village(packs).units[0]!.assertions.push("torre-scalini");
    expect(errorCodes(packs)).toContain("UNIT_ASSERTION_NOT_NARRATABLE");
  });

  it("non permette di raccontare livelli di qualità esclusi dalla configurazione", () => {
    const packs = loadSynthetic();
    village(packs).config.narration.allowedQualityTiers = ["gold"];
    expect(errorCodes(packs)).toContain("UNIT_ASSERTION_NOT_NARRATABLE");
  });

  it("avvisa se un concetto richiesto non è mai introdotto", () => {
    const packs = loadSynthetic();
    packs.get(AREA)!.units = packs.get(AREA)!.units.filter((u) => u.locale !== "en");
    expect(warningCodes(packs)).toContain("CONCEPT_NEVER_INTRODUCED");
  });

  it("rifiuta un'unità in una lingua non dichiarata", () => {
    const packs = loadSynthetic();
    village(packs).units[0]!.locale = "de";
    expect(errorCodes(packs)).toContain("UNIT_LOCALE");
  });
});

describe("percorsi", () => {
  it("rifiuta una tappa che non è un luogo", () => {
    const packs = loadSynthetic();
    village(packs).routes[0]!.stops[0]!.place = "leggenda-della-sirena";
    expect(errorCodes(packs)).toContain("ROUTE_STOP_KIND");
  });

  it("rifiuta un'ancora inesistente", () => {
    const packs = loadSynthetic();
    village(packs).routes[0]!.endAnchor = "molo-inesistente";
    expect(errorCodes(packs)).toContain("ROUTE_ANCHOR_UNKNOWN");
  });
});

describe("media", () => {
  const media = (packs: Map<string, TerritoryPack>, id: string) => village(packs).media.find((m) => m.id === id)!;

  it("accetta le immagini sintetiche e avvisa per la licenza non commerciale", () => {
    const packs = loadSynthetic();
    expect(village(packs).media).toHaveLength(2);
    expect(warningCodes(packs)).toContain("MEDIA_NON_COMMERCIAL");
  });

  it("non avvisa per la licenza non commerciale se il territorio la ammette", () => {
    const packs = loadSynthetic();
    village(packs).config.media.allowNonCommercial = true;
    expect(warningCodes(packs)).not.toContain("MEDIA_NON_COMMERCIAL");
  });

  it("rifiuta un file mancante", () => {
    const packs = loadSynthetic();
    media(packs, "porta-del-borgo-foto").file = "non-esiste.jpg";
    expect(errorCodes(packs)).toContain("MEDIA_FILE_MISSING");
  });

  it("rifiuta una licenza CC BY senza attribuzione", () => {
    const packs = loadSynthetic();
    delete media(packs, "torre-foto-nc").attribution;
    expect(errorCodes(packs)).toContain("MEDIA_ATTRIBUTION");
  });

  it("rifiuta un'immagine dal web senza indirizzo originale", () => {
    const packs = loadSynthetic();
    delete media(packs, "torre-foto-nc").originalUrl;
    expect(errorCodes(packs)).toContain("MEDIA_ORIGIN");
  });

  it("segnala un'immagine con tutti i diritti riservati come non pubblicabile", () => {
    const packs = loadSynthetic();
    const m = media(packs, "porta-del-borgo-foto");
    m.license = "all-rights-reserved";
    m.attribution = "© Redazione di test";
    expect(warningCodes(packs)).toContain("MEDIA_NOT_USABLE");
  });

  it("rifiuta un soggetto inesistente e il testo alternativo mancante", () => {
    const packs = loadSynthetic();
    const m = media(packs, "porta-del-borgo-foto");
    m.subjects = ["luogo-che-non-esiste"];
    m.alt = { en: "only english" };
    expect(errorCodes(packs)).toEqual(expect.arrayContaining(["UNRESOLVED_REF", "MEDIA_ALT"]));
  });
});

describe("verifica sul campo e stadi di rilascio", () => {
  const unitAssertion = (packs: Map<string, TerritoryPack>) => {
    const unit = village(packs).units[0]!;
    return village(packs).assertions.find((a) => a.id === unit.assertions[0])!;
  };

  it("in produzione pretende coordinate rilevate sul posto", () => {
    const packs = loadSynthetic();
    village(packs).places[0]!.coordinates = { status: "preliminary", mapSources: [] };
    expect(errorCodes(packs)).toContain("COORDINATES_NOT_VERIFIED");
  });

  it("in fase di ricerca le coordinate preliminari sono solo un avviso", () => {
    const packs = loadSynthetic();
    village(packs).manifest.releaseStage = "research";
    village(packs).places[0]!.coordinates = { status: "preliminary", mapSources: [] };
    expect(errorCodes(packs)).not.toContain("COORDINATES_NOT_VERIFIED");
    expect(warningCodes(packs)).toContain("COORDINATES_PRELIMINARY");
  });

  it("un'unità può usare affermazioni in revisione solo prima della produzione", () => {
    const packs = loadSynthetic();
    unitAssertion(packs).status = "in_review";
    delete unitAssertion(packs).verifiedBy;
    expect(errorCodes(packs)).toContain("UNIT_ASSERTION_NOT_NARRATABLE");
    village(packs).manifest.releaseStage = "field_test";
    expect(errorCodes(packs)).not.toContain("UNIT_ASSERTION_NOT_NARRATABLE");
    unitAssertion(packs).status = "draft";
    expect(errorCodes(packs)).toContain("UNIT_ASSERTION_NOT_NARRATABLE");
  });

  it("segnala geofence di arrivo sovrapposti", () => {
    const packs = loadSynthetic();
    const [a, b] = village(packs).places;
    a!.geofences = [{ kind: "arrival", radiusM: 50, minDwellS: 8, maxAccuracyM: 35 }];
    b!.geofences = [{ kind: "arrival", radiusM: 50, minDwellS: 8, maxAccuracyM: 35 }];
    b!.location = [a!.location[0], a!.location[1] + 0.0003]; // ~33 m
    expect(warningCodes(packs)).toContain("GEOFENCE_OVERLAP");
  });

  it("in produzione un percorso deve essere calibrato; una sola tappa è ammessa", () => {
    const packs = loadSynthetic();
    const route = village(packs).routes[0]!;
    route.stops = route.stops.slice(0, 1);
    expect(errorCodes(packs)).toEqual([]);
    route.calibration = "draft";
    expect(errorCodes(packs)).toContain("ROUTE_NOT_CALIBRATED");
  });

  it("le informazioni pratiche scadute vanno ricontrollate", () => {
    const packs = loadSynthetic();
    village(packs).places[0]!.practical = [
      { id: "orari", kind: "opening_hours", text: { it: "Aperto 9-18" }, checkedAt: "2026-01-01", recheckAfterDays: 30 },
    ];
    const issues = validatePacks(packs, { today: "2026-03-01" });
    expect(issues.map((i) => i.code)).toContain("PRACTICAL_STALE");
    expect(validatePacks(packs, { today: "2026-01-15" }).map((i) => i.code)).not.toContain("PRACTICAL_STALE");
  });
});

describe("collegamento alla fonte", () => {
  it("non si verifica un'affermazione su fonti solo dedotte", () => {
    const packs = loadSynthetic();
    const a = village(packs).assertions.find((x) => x.status === "verified" && x.evidence.length > 0)!;
    a.evidence = a.evidence.map((e) => ({ ...e, attribution: "inferred" as const }));
    expect(errorCodes(packs)).toContain("EVIDENCE_INFERRED");
  });

  it("in revisione, le fonti solo dedotte sono un avviso", () => {
    const packs = loadSynthetic();
    village(packs).manifest.releaseStage = "research";
    const a = village(packs).assertions.find((x) => x.status === "verified" && x.evidence.length > 0)!;
    a.status = "in_review";
    delete a.verifiedBy;
    a.evidence = a.evidence.map((e) => ({ ...e, attribution: "inferred" as const }));
    expect(errorCodes(packs)).not.toContain("EVIDENCE_INFERRED");
    expect(warningCodes(packs)).toContain("EVIDENCE_INFERRED");
  });
});

describe("verifica cartografica delle coordinate", () => {
  it("map_verified richiede data e fonti, e resta distinta dal campo", () => {
    const packs = loadSynthetic();
    village(packs).manifest.releaseStage = "research";
    const place = village(packs).places[0]!;
    place.coordinates = {
      status: "map_verified",
      mapVerifiedAt: "2026-10-09",
      mapSources: [{ title: "Cartografia di prova", reliability: "C" }],
      previousLocation: [0, 0],
    };
    expect(errorCodes(packs)).toEqual([]);
    expect(warningCodes(packs)).toContain("COORDINATES_MAP_ONLY");
    // In produzione la verifica su mappa non basta.
    village(packs).manifest.releaseStage = "production";
    expect(errorCodes(packs)).toContain("COORDINATES_NOT_VERIFIED");
  });
});
