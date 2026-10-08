import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  formatNodeRef,
  getPredicate,
  kindAllowed,
  LICENSE_RULES,
  MEDIA_FILES_DIR,
  PACK_FILES,
  resolveRef,
  type Assertion,
  type NodeKind,
  type TerritoryPack,
} from "@guide/domain";
import { IssueCollector, type PackIssue } from "./issues.ts";

/** Parole al secondo di una narrazione a voce: sotto o sopra questi limiti la durata è sospetta. */
const MIN_WORDS_PER_S = 1.5;
const MAX_WORDS_PER_S = 3.2;

interface NodeEntry {
  kind: NodeKind;
  packId: string;
}

interface Context {
  packs: Map<string, TerritoryPack>;
  /** Tutti i nodi (luoghi + nodi di conoscenza) per ref completo. */
  nodes: Map<string, NodeEntry>;
  sources: Map<string, { packId: string; fictional: boolean }>;
  /** Chiusura transitiva delle dipendenze, incluso il pack stesso. */
  reachable: Map<string, Set<string>>;
  out: IssueCollector;
}

/**
 * Valida un insieme di pack: schema già verificato al caricamento,
 * qui si controllano integrità referenziale, ontologia, regole di verifica
 * e coerenza narrativa, anche tra pack diversi.
 */
export function validatePacks(packs: Map<string, TerritoryPack>): PackIssue[] {
  const out = new IssueCollector();
  const ctx: Context = { packs, nodes: new Map(), sources: new Map(), reachable: new Map(), out };

  for (const pack of packs.values()) indexPack(pack, ctx);
  for (const pack of packs.values()) ctx.reachable.set(pack.manifest.id, resolveDependencies(pack, ctx));

  for (const pack of packs.values()) {
    checkManifest(pack, ctx);
    checkPlaces(pack, ctx);
    checkNodes(pack, ctx);
    checkAssertions(pack, ctx);
    checkUnits(pack, ctx);
    checkRoutes(pack, ctx);
    checkMedia(pack, ctx);
  }
  return out.issues;
}

// ------------------------------------------------------------------ indice

function indexPack(pack: TerritoryPack, ctx: Context): void {
  const packId = pack.manifest.id;
  const seen = new Map<string, string>();
  const register = (file: string, id: string, kind: NodeKind) => {
    const previous = seen.get(id);
    if (previous) {
      ctx.out.error({
        code: "DUPLICATE_ID",
        packId,
        file,
        item: id,
        message: `id già usato in ${previous}: luoghi e nodi condividono lo stesso spazio di nomi`,
      });
      return;
    }
    seen.set(id, file);
    ctx.nodes.set(formatNodeRef({ packId, slug: id }), { kind, packId });
  };
  for (const p of pack.places) register(PACK_FILES.places.path, p.id, "place");
  for (const n of pack.nodes) register(PACK_FILES.nodes.path, n.id, n.kind);

  for (const s of pack.sources) {
    const key = formatNodeRef({ packId, slug: s.id });
    if (ctx.sources.has(key)) {
      ctx.out.error({ code: "DUPLICATE_ID", packId, file: PACK_FILES.sources.path, item: s.id, message: "fonte duplicata" });
    }
    ctx.sources.set(key, { packId, fictional: s.fictional });
  }

  const checkUnique = (file: string, ids: string[]) => {
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    for (const id of new Set(dup)) ctx.out.error({ code: "DUPLICATE_ID", packId, file, item: id, message: "id duplicato" });
  };
  checkUnique(PACK_FILES.assertions.path, pack.assertions.map((a) => a.id));
  checkUnique(PACK_FILES.units.path, pack.units.map((u) => u.id));
  checkUnique(PACK_FILES.routes.path, pack.routes.map((r) => r.id));
  checkUnique(PACK_FILES.anchors.path, pack.anchors.map((a) => a.id));
  checkUnique(PACK_FILES.media.path, pack.media.map((m) => m.id));
}

function resolveDependencies(pack: TerritoryPack, ctx: Context): Set<string> {
  const result = new Set<string>([pack.manifest.id]);
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string) => {
    if (stack.includes(id)) {
      ctx.out.error({
        code: "DEPENDENCY_CYCLE",
        packId: pack.manifest.id,
        file: PACK_FILES.manifest.path,
        message: `dipendenze circolari: ${[...stack, id].join(" → ")}`,
      });
      return;
    }
    if (done.has(id)) return;
    const dep = ctx.packs.get(id);
    if (!dep) return;
    stack.push(id);
    for (const next of dep.manifest.dependsOn) {
      if (!ctx.packs.has(next)) continue;
      result.add(next);
      visit(next);
    }
    stack.pop();
    done.add(id);
  };
  visit(pack.manifest.id);
  return result;
}

// --------------------------------------------------------------- helper

/** Risolve un riferimento a un nodo e verifica che sia raggiungibile dal pack. */
function lookupNode(
  raw: string,
  pack: TerritoryPack,
  ctx: Context,
  where: { file: string; item: string },
): (NodeEntry & { ref: string }) | null {
  const packId = pack.manifest.id;
  const parsed = resolveRef(raw, packId);
  if (!parsed) {
    ctx.out.error({ code: "INVALID_REF", packId, ...where, message: `riferimento non valido: ${raw}` });
    return null;
  }
  const ref = formatNodeRef(parsed);
  if (!ctx.reachable.get(packId)?.has(parsed.packId)) {
    ctx.out.error({
      code: "UNDECLARED_DEPENDENCY",
      packId,
      ...where,
      message: `${ref} appartiene al pack ${parsed.packId}, che non è tra le dipendenze (dependsOn)`,
    });
    return null;
  }
  const entry = ctx.nodes.get(ref);
  if (!entry) {
    ctx.out.error({ code: "UNRESOLVED_REF", packId, ...where, message: `nodo inesistente: ${ref}` });
    return null;
  }
  return { ...entry, ref };
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// --------------------------------------------------------------- manifest

function checkManifest(pack: TerritoryPack, ctx: Context): void {
  const m = pack.manifest;
  const file = PACK_FILES.manifest.path;
  if (basename(pack.dir) !== m.id) {
    ctx.out.error({ code: "PACK_DIR_MISMATCH", packId: m.id, file, message: `la cartella deve chiamarsi come l'id del pack (${m.id})` });
  }
  if (!m.locales.includes(m.defaultLocale)) {
    ctx.out.error({ code: "DEFAULT_LOCALE", packId: m.id, file, message: "defaultLocale deve comparire in locales" });
  }
  if (!m.name[m.defaultLocale]) {
    ctx.out.error({ code: "NAME_MISSING", packId: m.id, file, message: `manca il nome nella lingua predefinita (${m.defaultLocale})` });
  }
  for (const dep of m.dependsOn) {
    const target = ctx.packs.get(dep);
    if (!target) {
      ctx.out.error({ code: "DEPENDENCY_MISSING", packId: m.id, file, item: dep, message: `dipendenza non trovata: ${dep}` });
      continue;
    }
    if (target.manifest.fictional && !m.fictional) {
      ctx.out.error({
        code: "FICTIONAL_DEPENDENCY",
        packId: m.id,
        file,
        item: dep,
        message: "un pack reale non può dipendere da un pack fittizio (di test)",
      });
    }
  }
  if (!pack.config.narration.allowedQualityTiers.length) {
    ctx.out.error({ code: "CONFIG", packId: m.id, file: PACK_FILES.config.path, message: "nessun livello di qualità ammesso" });
  }
}

// ----------------------------------------------------------------- luoghi

function checkLabels(
  pack: TerritoryPack,
  ctx: Context,
  file: string,
  item: string,
  labels: Partial<Record<string, unknown>>,
): void {
  const { defaultLocale, locales, id: packId } = pack.manifest;
  if (!labels[defaultLocale]) {
    ctx.out.error({ code: "LABEL_MISSING", packId, file, item, message: `manca il nome in ${defaultLocale}` });
  }
  for (const loc of locales) {
    if (loc !== defaultLocale && !labels[loc]) {
      ctx.out.warning({ code: "LABEL_MISSING_LOCALE", packId, file, item, message: `manca il nome in ${loc}` });
    }
  }
}

function checkPlaces(pack: TerritoryPack, ctx: Context): void {
  const file = PACK_FILES.places.path;
  const packId = pack.manifest.id;
  for (const place of pack.places) {
    checkLabels(pack, ctx, file, place.id, place.labels);
    if (place.partOf) {
      const parent = lookupNode(place.partOf, pack, ctx, { file, item: place.id });
      if (parent && parent.kind !== "place" && parent.kind !== "territory") {
        ctx.out.error({ code: "PART_OF_KIND", packId, file, item: place.id, message: "partOf deve indicare un luogo o un territorio" });
      }
      if (parent?.ref === formatNodeRef({ packId, slug: place.id })) {
        ctx.out.error({ code: "PART_OF_SELF", packId, file, item: place.id, message: "un luogo non può far parte di sé stesso" });
      }
    }
    if (place.placeKind === "poi" && place.importance >= 3 && !place.geofences.some((g) => g.kind === "arrival")) {
      ctx.out.warning({
        code: "GEOFENCE_MISSING",
        packId,
        file,
        item: place.id,
        message: "POI importante senza geofence di arrivo: la guida non lo riconoscerà da sola",
      });
    }
  }
  for (const anchor of pack.anchors) checkLabels(pack, ctx, PACK_FILES.anchors.path, anchor.id, anchor.labels);
}

function checkNodes(pack: TerritoryPack, ctx: Context): void {
  for (const node of pack.nodes) checkLabels(pack, ctx, PACK_FILES.nodes.path, node.id, node.labels);
}

// ----------------------------------------------------------- affermazioni

function checkAssertions(pack: TerritoryPack, ctx: Context): void {
  const file = PACK_FILES.assertions.path;
  const { id: packId, locales, defaultLocale, fictional } = pack.manifest;
  const disputes = new Map<string, Assertion[]>();

  for (const a of pack.assertions) {
    const where = { file, item: a.id };
    const subject = lookupNode(a.subject, pack, ctx, where);
    const predicate = getPredicate(a.predicate);

    if (!predicate) {
      ctx.out.error({ code: "UNKNOWN_PREDICATE", packId, ...where, message: `predicato sconosciuto: ${a.predicate}` });
    } else {
      if (subject && !kindAllowed(predicate.domain, subject.kind)) {
        ctx.out.error({
          code: "PREDICATE_DOMAIN",
          packId,
          ...where,
          message: `'${a.predicate}' non si applica a un nodo di tipo ${subject.kind}`,
        });
      }
      if (predicate.kind === "relation") {
        if (!a.object) {
          ctx.out.error({ code: "OBJECT_REQUIRED", packId, ...where, message: `'${a.predicate}' richiede un object` });
        } else {
          const object = lookupNode(a.object, pack, ctx, where);
          if (object && !kindAllowed(predicate.range, object.kind)) {
            ctx.out.error({
              code: "PREDICATE_RANGE",
              packId,
              ...where,
              message: `'${a.predicate}' non può puntare a un nodo di tipo ${object.kind}`,
            });
          }
        }
        if (a.value) ctx.out.error({ code: "VALUE_NOT_ALLOWED", packId, ...where, message: "una relazione non ha value" });
      }
      if (predicate.kind === "value") {
        if (!a.value) {
          ctx.out.error({ code: "VALUE_REQUIRED", packId, ...where, message: `'${a.predicate}' richiede un value` });
        } else {
          const isYear = "yearFrom" in a.value;
          if ((predicate.value === "year_range") !== isYear) {
            ctx.out.error({
              code: "VALUE_SHAPE",
              packId,
              ...where,
              message: `'${a.predicate}' richiede un valore di tipo ${predicate.value}`,
            });
          }
        }
        if (a.object) ctx.out.error({ code: "OBJECT_NOT_ALLOWED", packId, ...where, message: "un attributo non ha object" });
      }
      if (predicate.kind === "statement" && (a.object || a.value)) {
        ctx.out.error({ code: "STATEMENT_SHAPE", packId, ...where, message: "un'affermazione testuale non ha né object né value" });
      }
      if (a.predicate === "tells" && a.type !== "legend") {
        ctx.out.error({ code: "LEGEND_TYPE", packId, ...where, message: "il contenuto di una leggenda ('tells') deve avere type: legend" });
      }
    }

    // Certezza: ha senso solo per fatti e interpretazioni.
    if ((a.type === "fact" || a.type === "interpretation") && !a.certainty) {
      ctx.out.error({ code: "CERTAINTY_REQUIRED", packId, ...where, message: `type ${a.type} richiede certainty` });
    }
    if ((a.type === "legend" || a.type === "tradition") && a.certainty) {
      ctx.out.warning({ code: "CERTAINTY_IGNORED", packId, ...where, message: `certainty non si applica a type ${a.type}` });
    }

    // Controversie.
    if (a.type === "disputed" && !a.dispute) {
      ctx.out.error({ code: "DISPUTE_REQUIRED", packId, ...where, message: "type disputed richiede il gruppo 'dispute'" });
    }
    if (a.dispute) disputes.set(a.dispute, [...(disputes.get(a.dispute) ?? []), a]);

    // Prove e fonti.
    if (a.evidence.length === 0) {
      const issue = { code: "EVIDENCE_REQUIRED", packId, ...where, message: "nessuna fonte collegata" };
      if (a.status === "draft") ctx.out.warning(issue);
      else ctx.out.error(issue);
    }
    for (const ev of a.evidence) {
      const parsed = resolveRef(ev.source, packId);
      const key = parsed ? formatNodeRef(parsed) : ev.source;
      const source = ctx.sources.get(key);
      if (!parsed || !source || !ctx.reachable.get(packId)?.has(parsed.packId)) {
        ctx.out.error({ code: "SOURCE_NOT_FOUND", packId, ...where, message: `fonte non trovata o non raggiungibile: ${key}` });
      } else if (source.fictional && !fictional) {
        ctx.out.error({ code: "FICTIONAL_SOURCE", packId, ...where, message: "un pack reale non può citare una fonte fittizia" });
      }
    }

    // Regola dei quattro occhi.
    if (a.status === "verified") {
      if (!a.verifiedBy) {
        ctx.out.error({ code: "VERIFIER_REQUIRED", packId, ...where, message: "un'affermazione verificata richiede verifiedBy" });
      } else if (a.verifiedBy === a.authoredBy) {
        ctx.out.error({ code: "FOUR_EYES", packId, ...where, message: "chi verifica non può essere chi ha scritto" });
      }
    }

    // Testi.
    if (!a.texts[defaultLocale]) {
      ctx.out.error({ code: "TEXT_MISSING", packId, ...where, message: `manca il testo in ${defaultLocale}` });
    }
    for (const loc of locales) {
      if (loc !== defaultLocale && !a.texts[loc]) {
        ctx.out.warning({ code: "TEXT_MISSING_LOCALE", packId, ...where, message: `manca il testo in ${loc}` });
      }
    }
  }

  for (const [group, members] of disputes) {
    if (members.length < 2) {
      ctx.out.error({
        code: "DISPUTE_SINGLE",
        packId,
        file,
        item: group,
        message: "una controversia deve raggruppare almeno due affermazioni alternative",
      });
    }
  }
}

// ------------------------------------------------------- unità narrative

function checkUnits(pack: TerritoryPack, ctx: Context): void {
  const file = PACK_FILES.units.path;
  const { id: packId, locales, qualityTier: packTier } = pack.manifest;
  const allowedTiers = new Set(pack.config.narration.allowedQualityTiers);
  const assertions = new Map(pack.assertions.map((a) => [a.id, a]));

  // Concetti introdotti da qualche unità, per lingua, in questo pack o nelle sue dipendenze.
  const introduced = new Map<string, Set<string>>();
  for (const depId of ctx.reachable.get(packId) ?? []) {
    const dep = ctx.packs.get(depId);
    for (const unit of dep?.units ?? []) {
      for (const raw of unit.introduces) {
        const parsed = resolveRef(raw, depId);
        if (!parsed) continue;
        const set = introduced.get(unit.locale) ?? new Set<string>();
        set.add(formatNodeRef(parsed));
        introduced.set(unit.locale, set);
      }
    }
  }

  for (const unit of pack.units) {
    const where = { file, item: unit.id };
    if (!locales.includes(unit.locale)) {
      ctx.out.error({ code: "UNIT_LOCALE", packId, ...where, message: `lingua ${unit.locale} non dichiarata nel pack` });
    }
    lookupNode(unit.anchor, pack, ctx, where);

    for (const id of unit.assertions) {
      const a = assertions.get(id);
      if (!a) {
        ctx.out.error({ code: "UNIT_ASSERTION_UNKNOWN", packId, ...where, message: `affermazione inesistente: ${id}` });
        continue;
      }
      const tier = a.qualityTier ?? packTier;
      if (a.status !== "verified" || !allowedTiers.has(tier)) {
        ctx.out.error({
          code: "UNIT_ASSERTION_NOT_NARRATABLE",
          packId,
          ...where,
          message: `l'affermazione ${id} non è utilizzabile (stato ${a.status}, livello ${tier})`,
        });
      }
    }

    for (const raw of [...unit.introduces, ...unit.requires, ...unit.hooks.map((h) => h.target)]) {
      lookupNode(raw, pack, ctx, where);
    }
    for (const raw of unit.requires) {
      const parsed = resolveRef(raw, packId);
      if (parsed && !introduced.get(unit.locale)?.has(formatNodeRef(parsed))) {
        ctx.out.warning({
          code: "CONCEPT_NEVER_INTRODUCED",
          packId,
          ...where,
          message: `richiede ${formatNodeRef(parsed)}, ma nessuna unità in ${unit.locale} lo introduce`,
        });
      }
    }

    const words = wordCount(unit.text);
    if (words < unit.durationS * MIN_WORDS_PER_S || words > unit.durationS * MAX_WORDS_PER_S) {
      ctx.out.warning({
        code: "UNIT_DURATION",
        packId,
        ...where,
        message: `${words} parole per ${unit.durationS} s: durata probabilmente da rivedere`,
      });
    }
  }
}

// ----------------------------------------------------------------- percorsi

function checkRoutes(pack: TerritoryPack, ctx: Context): void {
  const file = PACK_FILES.routes.path;
  const packId = pack.manifest.id;
  const anchors = new Set(pack.anchors.map((a) => a.id));
  for (const route of pack.routes) {
    const where = { file, item: route.id };
    checkLabels(pack, ctx, file, route.id, route.labels);
    const seen = new Set<string>();
    for (const stop of route.stops) {
      const node = lookupNode(stop.place, pack, ctx, where);
      if (node && node.kind !== "place") {
        ctx.out.error({ code: "ROUTE_STOP_KIND", packId, ...where, message: `${node.ref} non è un luogo` });
      }
      if (node && seen.has(node.ref)) {
        ctx.out.warning({ code: "ROUTE_STOP_REPEATED", packId, ...where, message: `${node.ref} compare più volte` });
      }
      if (node) seen.add(node.ref);
    }
    if (route.endAnchor && !anchors.has(route.endAnchor)) {
      ctx.out.error({ code: "ROUTE_ANCHOR_UNKNOWN", packId, ...where, message: `ancora inesistente: ${route.endAnchor}` });
    }
  }
}

// -------------------------------------------------------------------- media

function checkMedia(pack: TerritoryPack, ctx: Context): void {
  const file = PACK_FILES.media.path;
  const { id: packId, defaultLocale } = pack.manifest;
  const allowNonCommercial = pack.config.media.allowNonCommercial;
  const usedFiles = new Map<string, string>();

  for (const m of pack.media) {
    const where = { file, item: m.id };
    for (const raw of m.subjects) lookupNode(raw, pack, ctx, where);

    if (!existsSync(join(pack.dir, MEDIA_FILES_DIR, m.file))) {
      ctx.out.error({ code: "MEDIA_FILE_MISSING", packId, ...where, message: `file non trovato: ${MEDIA_FILES_DIR}/${m.file}` });
    }
    const other = usedFiles.get(m.file);
    if (other) ctx.out.warning({ code: "MEDIA_FILE_REUSED", packId, ...where, message: `stesso file di ${other}` });
    usedFiles.set(m.file, m.id);

    const rules = LICENSE_RULES[m.license];
    if (rules.attributionRequired && !m.attribution) {
      ctx.out.error({ code: "MEDIA_ATTRIBUTION", packId, ...where, message: `la licenza ${m.license} richiede l'attribuzione` });
    }
    if (m.source === "web" && !m.originalUrl) {
      ctx.out.error({ code: "MEDIA_ORIGIN", packId, ...where, message: "un'immagine presa dal web richiede originalUrl" });
    }
    if ((m.source === "institution" || m.source === "archive") && !m.originalUrl && !m.licenseNote) {
      ctx.out.warning({ code: "MEDIA_ORIGIN", packId, ...where, message: "indicare originalUrl o un riferimento all'accordo (licenseNote)" });
    }
    if (m.license === "all-rights-reserved") {
      ctx.out.warning({ code: "MEDIA_NOT_USABLE", packId, ...where, message: "tutti i diritti riservati: l'immagine resta in archivio ma non viene pubblicata" });
    } else if (!rules.commercialUse && !allowNonCommercial) {
      ctx.out.warning({ code: "MEDIA_NON_COMMERCIAL", packId, ...where, message: `licenza ${m.license} non commerciale: esclusa dal pacchetto pubblicato` });
    }
    if (!m.alt[defaultLocale]) {
      ctx.out.error({ code: "MEDIA_ALT", packId, ...where, message: `manca il testo alternativo in ${defaultLocale}` });
    }
  }
}
