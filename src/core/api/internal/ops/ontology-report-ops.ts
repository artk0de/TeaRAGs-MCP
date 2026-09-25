/**
 * OntologyReportOps — the query behind `get_ontology_report`
 * (bd tea-rags-mcp-4p3sb.20): a project-wide audit of how declared values are
 * named against their types.
 *
 * DuckDB does the aggregation (`GraphDbClient#readOntologyReport`, one query per
 * section); this class owns the POLICY — the thresholds, which language's
 * non-concept types and casing apply to which file — and the naming-shape
 * judgement, which is the naming lexicon's pure classifier fed the canonical
 * casing of the row's language. Lives in `api/internal` because it bridges the
 * language descriptors, the explore domain's shape logic and the public DTO.
 *
 * Thresholds, and why:
 *   - `minSupport` 5 — below five rows a distribution is anecdote; the same
 *     floor the naming lexicon widens its scope at;
 *   - `synonymDominantShareCeiling` 0.8 — a type whose top name holds 80% of its
 *     rows is consistent; the share the lexicon's name inference trusts;
 *   - generic = bound to ≥ 5 types, none holding half of the name's rows — a
 *     name that denotes nothing in particular (`result`, `data`, `item`);
 *   - homonym types need ≥ 2 rows and ≥ 10% of the name's rows — one stray
 *     binding is noise, not a second meaning;
 *   - a synonym's dominant name needs ≥ 2 rows ({@link SYNONYM_MIN_DOMINANT_ROWS});
 *   - outliers need a convention: the top name holds ≥ 50% of the group; a
 *     name EXACT for its type is never an outlier, nor is one whose shape is at
 *     least as strong as the dominant name's;
 *   - confidence `min(1, (n/20)^2)`, the lexicon's quadratic dampening.
 */

import type { GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import type {
  OntologyEvidenceCounts,
  OntologyLocationRow,
  OntologyNameCountRow,
  OntologyReportQuery,
  OntologyReportRows,
  OntologyReportSection,
  OntologyReportThresholds,
  OntologyTypeGroupRow,
} from "../../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type { IdentifierCasing, IdentifierNamingConvention } from "../../../contracts/types/language.js";
import {
  classifyNamingShape,
  detectIdentifierCasing,
  isTypeFamilyRoleName,
  isWeakerNamingShape,
  mergeUnqualifiedTypeSpellings,
  singularizeIdentifierWord,
  splitIdentifierWords,
  type NamingShape,
} from "../../../domains/explore/naming-lexicon/index.js";
import { LANGUAGE_MAP } from "../../../domains/ingest/pipeline/chunker/config.js";
import { nativeLanguageCapabilities } from "../../../domains/language/capability/native.js";
import type { CollectionRegistry } from "../../../domains/maintenance/registry/index.js";
import { resolvePhysicalCollection } from "../../../infra/collection-name.js";
import { InvalidParameterError } from "../../errors.js";
import type {
  GetOntologyReportRequest,
  GetOntologyReportResponse,
  OntologyCollision,
  OntologyEvidence,
  OntologyHomonym,
  OntologyLocation,
  OntologyNameCount,
  OntologyOutlier,
  OntologyReportSectionName,
  OntologySynonym,
  OntologyValueKind,
} from "../../public/dto/ontology.js";
import { resolveCollection } from "../collection-resolver.js";

/** Default `GetOntologyReportRequest.limit`. */
export const DEFAULT_ONTOLOGY_REPORT_LIMIT = 20;
/** Hard cap on `limit`, whatever the caller asks. */
export const MAX_ONTOLOGY_REPORT_LIMIT = 100;
/** Candidate groups read per returned synonym / outlier / homonym item. */
const GROUP_POOL_FACTOR = 4;
/**
 * A synonym entry's dominant name must occur at least this often. A type whose
 * every name occurs once (`ChunkingHook` → `rspecFilterHook`, `goHook`, …) is a
 * set of distinct singleton instances, each named for itself — no convention.
 */
const SYNONYM_MIN_DOMINANT_ROWS = 2;

/** The judging thresholds — see the module doc for why each value. `groupPool` is derived from `limit`. */
export const ONTOLOGY_REPORT_THRESHOLDS: Omit<OntologyReportThresholds, "groupPool"> = {
  minSupport: 5,
  synonymDominantShareCeiling: 0.8,
  genericMinTypes: 5,
  genericMaxTopTypeShare: 0.5,
  homonymMinTypeRows: 2,
  homonymMinTypeShare: 0.1,
  outlierMinDominantShare: 0.5,
  confidenceSupport: 20,
  namesPerItem: 6,
};

const ALL_SECTIONS: readonly OntologyReportSectionName[] = ["synonyms", "homonyms", "outliers", "collisions"];

/** Glob metacharacters that end a pathPattern's literal prefix. */
const GLOB_META = /[*?{[]/;

/** One language's naming facts and the file extensions they apply to. */
export interface OntologyLanguageProfile {
  language: string;
  /** Lowercase, dot included (`.rb`). */
  extensions: readonly string[];
  naming: IdentifierNamingConvention;
}

/**
 * A profile per language whose descriptor declares `naming` — the extension
 * map the chunker routes files by, joined to the language descriptors.
 */
export function ontologyLanguageProfiles(): OntologyLanguageProfile[] {
  const profiles: OntologyLanguageProfile[] = [];
  for (const [language, capability] of nativeLanguageCapabilities()) {
    if (!capability.naming) continue;
    const extensions = Object.entries(LANGUAGE_MAP)
      .filter(([, lang]) => lang === language)
      .map(([extension]) => extension.toLowerCase());
    if (extensions.length > 0) profiles.push({ language, extensions, naming: capability.naming });
  }
  return profiles;
}

export interface OntologyReportOpsDeps {
  pool: Pick<GraphDbClientPool, "acquireReader">;
  collectionRegistry: CollectionRegistry;
  /** Alias → active versioned collection (see `GraphFacadeDeps.resolveActiveCollection`). */
  resolveActiveCollection?: (collectionName: string) => Promise<PhysicalCollectionName>;
  languages: readonly OntologyLanguageProfile[];
}

/** Literal `rel_path` prefix of a glob: everything before the first metacharacter. */
function pathPatternPrefix(pathPattern: string | undefined): string {
  if (!pathPattern) return "";
  const meta = pathPattern.search(GLOB_META);
  return (meta === -1 ? pathPattern : pathPattern.slice(0, meta)).replace(/^\.\//, "");
}

function requestedSections(req: Pick<GetOntologyReportRequest, "sections">): OntologyReportSectionName[] {
  return req.sections && req.sections.length > 0
    ? ALL_SECTIONS.filter((s) => req.sections?.includes(s))
    : [...ALL_SECTIONS];
}

function confidence(n: number, support: number): number {
  return Math.min(1, (n / support) ** 2);
}

function location(row: OntologyLocationRow): OntologyLocation {
  return { relPath: row.relPath, line: row.line, symbolId: row.ownerSymbolId };
}

function evidence(counts: OntologyEvidenceCounts): OntologyEvidence {
  return { ...counts };
}

/** Shape families: a name departs from a convention when its family differs, not merely its shape. */
function shapeFamily(shape: NamingShape): "type" | "callee" | "free" {
  if (shape === "FREE") return "free";
  if (shape === "CALLEE_DERIVED") return "callee";
  return "type";
}

/** Singular and plural of one word sequence, any casing, collapse to one key: `invoices` ≡ `invoice`. */
function mergeKey(name: string): string {
  const words = splitIdentifierWords(name);
  if (words.length === 0) return name;
  words[words.length - 1] = singularizeIdentifierWord(words[words.length - 1]);
  return words.join("_");
}

export class OntologyReportOps {
  private readonly profileByExtension = new Map<string, OntologyLanguageProfile>();

  constructor(private readonly deps: OntologyReportOpsDeps) {
    for (const profile of deps.languages) {
      for (const extension of profile.extensions) this.profileByExtension.set(extension, profile);
    }
  }

  async report(req: GetOntologyReportRequest): Promise<GetOntologyReportResponse> {
    const language = req.language ? this.languageProfile(req.language) : undefined;
    const query = this.buildQuery(req, language);

    const { collectionName } = resolveCollection(this.deps.collectionRegistry, req);
    const active = this.deps.resolveActiveCollection
      ? await this.deps
          .resolveActiveCollection(collectionName)
          .catch(() => resolvePhysicalCollection(collectionName, []))
      : resolvePhysicalCollection(collectionName, []);

    let handle: Awaited<ReturnType<GraphDbClientPool["acquireReader"]>>;
    try {
      handle = await this.deps.pool.acquireReader(active);
    } catch (error) {
      // An unreadable graph must not pass for a clean project.
      const message = error instanceof Error ? error.message : String(error);
      return { ...OntologyReportOps.empty(req), notices: [`codegraph store unavailable: ${message}`] };
    }

    let rows: OntologyReportRows;
    try {
      rows = await handle.graphDb.readOntologyReport(query);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("cg_identifiers") && message.includes("does not exist")) {
        return { ...OntologyReportOps.empty(req), driftWarning: MISSING_TABLE_WARNING };
      }
      throw error;
    } finally {
      await handle.graphDb.close().catch(() => undefined);
    }
    return this.shape(req, rows);
  }

  /** The report for a collection with no readable codegraph: nothing read, requested sections empty. */
  static empty(
    req: Pick<GetOntologyReportRequest, "pathPattern" | "language" | "sections">,
  ): GetOntologyReportResponse {
    const response: GetOntologyReportResponse = {
      scope: scopeOf(req),
      summary: { evidenceRows: 0, genericNameCount: 0, genericNames: [] },
    };
    for (const section of requestedSections(req)) response[section] = [];
    return response;
  }

  private languageProfile(language: string): OntologyLanguageProfile {
    const profile = this.deps.languages.find((p) => p.language === language.trim().toLowerCase());
    if (!profile) {
      throw new InvalidParameterError(
        "language",
        `no naming descriptor for "${language}"; one of: ${this.deps.languages.map((p) => p.language).join(", ")}`,
      );
    }
    return profile;
  }

  private buildQuery(
    req: GetOntologyReportRequest,
    language: OntologyLanguageProfile | undefined,
  ): OntologyReportQuery {
    const limit = Math.min(MAX_ONTOLOGY_REPORT_LIMIT, Math.max(1, req.limit ?? DEFAULT_ONTOLOGY_REPORT_LIMIT));
    const prefix = pathPatternPrefix(req.pathPattern);
    const sections: OntologyReportSection[] = requestedSections(req);
    return {
      ...(prefix ? { pathPrefixes: [prefix] } : {}),
      ...(language ? { extensions: [...language.extensions] } : {}),
      nonConceptTypes: this.deps.languages.map((p) => ({
        extensions: [...p.extensions],
        typeNames: [...p.naming.nonConceptTypes],
      })),
      sections,
      limit,
      thresholds: { ...ONTOLOGY_REPORT_THRESHOLDS, groupPool: limit * GROUP_POOL_FACTOR },
    };
  }

  private shape(req: GetOntologyReportRequest, rows: OntologyReportRows): GetOntologyReportResponse {
    const limit = Math.min(MAX_ONTOLOGY_REPORT_LIMIT, Math.max(1, req.limit ?? DEFAULT_ONTOLOGY_REPORT_LIMIT));
    const response: GetOntologyReportResponse = {
      scope: scopeOf(req),
      summary: {
        evidenceRows: rows.evidenceRows,
        genericNameCount: rows.genericNameCount,
        genericNames: rows.genericNames.map((g) => ({ ...g })),
      },
    };
    if (rows.synonyms) response.synonyms = this.synonyms(rows.synonyms, limit);
    if (rows.homonyms) response.homonyms = this.homonyms(rows.homonyms, limit);
    if (rows.outlierGroups) response.outliers = this.outliers(rows.outlierGroups, limit);
    if (rows.collisions) response.collisions = this.collisions(rows.collisions);
    if (rows.totals.identifierRows === 0 && rows.totals.symbolRows > 0) {
      response.driftWarning = `cg_identifiers is empty while the codegraph holds ${rows.totals.symbolRows} symbols: ${STALE_INDEX_HINT}`;
    }
    return response;
  }

  /** The canonical casing of `kind` in the language of `relPath`; else the casing `sampleName` is written in. */
  private casingFor(relPath: string, kind: OntologyValueKind, sampleName: string): IdentifierCasing {
    const dot = relPath.lastIndexOf(".");
    const profile = dot === -1 ? undefined : this.profileByExtension.get(relPath.slice(dot).toLowerCase());
    return profile?.naming.casing[kind][0] ?? detectIdentifierCasing(sampleName) ?? "snake";
  }

  private nameCount(
    item: OntologyNameCountRow,
    typeName: string,
    kind: OntologyValueKind,
    casing: IdentifierCasing,
  ): OntologyNameCount {
    return {
      name: item.name,
      n: item.n,
      shape: classifyNamingShape({ name: item.name, kind, casing, typeName }),
      example: location(item.example),
    };
  }

  /**
   * Re-judges the pooled candidate groups with singular and plural merged — a
   * type named `invoice` and `invoices` is one name, not two — keeps the ones
   * still below the dominance ceiling, re-ranks by `(1 − share) × confidence`.
   */
  private synonyms(groups: readonly OntologyTypeGroupRow[], limit: number): OntologySynonym[] {
    const t = ONTOLOGY_REPORT_THRESHOLDS;
    const judged: (OntologySynonym & { score: number })[] = [];
    for (const group of groups) {
      if (group.names.length === 0) continue;
      const buckets = new Map<string, { n: number; names: OntologyNameCountRow[] }>();
      for (const item of group.names) {
        const key = mergeKey(item.name);
        const bucket = buckets.get(key) ?? { n: 0, names: [] };
        bucket.n += item.n;
        bucket.names.push(item);
        buckets.set(key, bucket);
      }
      const top = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
      if (top.n < SYNONYM_MIN_DOMINANT_ROWS) continue;
      const dominantShare = top.n / group.n;
      if (dominantShare >= t.synonymDominantShareCeiling) continue;
      const casing = this.casingFor(top.names[0].example.relPath, group.kind, top.names[0].name);
      const dominantNames = new Set(top.names.map((item) => item.name));
      const conf = confidence(group.n, t.confidenceSupport);
      judged.push({
        type: group.typeName,
        kind: group.kind,
        n: group.n,
        confidence: conf,
        dominantShare,
        entropy: group.entropy,
        distinctNames: group.distinctNames,
        dominant: { ...this.nameCount(top.names[0], group.typeName, group.kind, casing), n: top.n },
        deviants: group.names
          .filter((item) => !dominantNames.has(item.name))
          .slice(0, t.namesPerItem - 1)
          .map((item) => this.nameCount(item, group.typeName, group.kind, casing)),
        evidence: evidence(group.evidence),
        score: (1 - dominantShare) * conf,
      });
    }
    return judged
      .sort((a, b) => b.score - a.score || b.n - a.n)
      .slice(0, limit)
      .map(({ score: _score, ...synonym }) => synonym);
  }

  /**
   * Re-judges the pooled homonym candidates: an unqualified spelling folds into
   * the qualified type it names (`Document` into `TaxPreparation::Document`), and
   * a name that is the role word of a type family (`state` for `ClientState`,
   * `RunState`; `ctx` for `LogContext`, `ReindexContext`) is dropped. The rest re-rank by `(1 − top type share) ×
   * confidence`, capped at `limit` names and `namesPerItem` types.
   */
  private homonyms(rows: NonNullable<OntologyReportRows["homonyms"]>, limit: number): OntologyHomonym[] {
    const t = ONTOLOGY_REPORT_THRESHOLDS;
    const judged: (OntologyHomonym & { score: number })[] = [];
    for (const row of rows) {
      const types = mergeUnqualifiedTypeSpellings(row.types).map((type) => ({
        type: type.typeName,
        n: type.n,
        shape: classifyNamingShape({
          name: row.name,
          kind: "local",
          casing: this.casingFor(type.example.relPath, "local", row.name),
          typeName: type.typeName,
        }),
        example: location(type.example),
      }));
      if (types.length < 2) continue;
      const typeShapes = types.map(({ type, shape }) => ({ typeName: type, shape }));
      if (isTypeFamilyRoleName(typeShapes, row.name)) continue;
      const topTypeShare = types[0].n / row.n;
      const conf = confidence(row.n, t.confidenceSupport);
      judged.push({
        name: row.name,
        n: row.n,
        confidence: conf,
        topTypeShare,
        types: types.slice(0, t.namesPerItem),
        evidence: evidence(row.evidence),
        score: (1 - topTypeShare) * conf,
      });
    }
    return judged
      .sort((a, b) => b.score - a.score || b.n - a.n || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map(({ score: _score, ...homonym }) => homonym);
  }

  /**
   * A name is an outlier when its shape FAMILY (type-derived / callee-derived /
   * free) differs from the family holding most of its group's rows AND its
   * shape is weaker than the dominant name's ({@link isWeakerNamingShape}) —
   * `tax_automation_document_ignored` (QUALIFIED) conforms to an EXACT
   * convention, `tad` (FREE) does not; `collectionName` (TAIL) against a
   * `coll` (FREE) habit is the better name, not the deviant. Ranked by how
   * strong the convention is: family share × confidence.
   */
  private outliers(groups: readonly OntologyTypeGroupRow[], limit: number): OntologyOutlier[] {
    const t = ONTOLOGY_REPORT_THRESHOLDS;
    const judged: (OntologyOutlier & { score: number; groupN: number })[] = [];
    for (const group of groups) {
      if (group.names.length < 2) continue;
      const casing = this.casingFor(group.names[0].example.relPath, group.kind, group.names[0].name);
      const named = group.names.map((item) => this.nameCount(item, group.typeName, group.kind, casing));
      const judgedRows = named.reduce((s, item) => s + item.n, 0);
      const familyRows = new Map<string, number>();
      for (const item of named) {
        const family = shapeFamily(item.shape);
        familyRows.set(family, (familyRows.get(family) ?? 0) + item.n);
      }
      const [dominantFamily, dominantRows] = [...familyRows].sort((a, b) => b[1] - a[1])[0];
      const shapeShare = dominantRows / judgedRows;
      if (shapeShare < t.outlierMinDominantShare) continue;
      const dominant = named.find((item) => shapeFamily(item.shape) === dominantFamily);
      if (!dominant) continue;
      const conf = confidence(group.n, t.confidenceSupport);
      for (const item of named) {
        // EXACT is the type's own spelling: canonical whatever the group's habit.
        if (item.shape === "EXACT" || shapeFamily(item.shape) === dominantFamily) continue;
        // A name spelling more of the type than the convention does is not the one departing from it.
        if (!isWeakerNamingShape(item.shape, dominant.shape)) continue;
        judged.push({
          type: group.typeName,
          kind: group.kind,
          name: item.name,
          n: item.n,
          shape: item.shape,
          dominant: { name: dominant.name, n: dominant.n, shape: dominant.shape, shapeShare },
          confidence: conf,
          example: item.example,
          evidence: evidence(group.evidence),
          score: shapeShare * conf,
          groupN: group.n,
        });
      }
    }
    return judged
      .sort((a, b) => b.score - a.score || b.groupN - a.groupN || a.n - b.n)
      .slice(0, limit)
      .map(({ score: _score, groupN: _groupN, ...outlier }) => outlier);
  }

  private collisions(rows: NonNullable<OntologyReportRows["collisions"]>): OntologyCollision[] {
    return rows.map((row) => ({
      rule: row.rule,
      name: row.name,
      symbol: row.symbol,
      ...(row.typeName ? { type: row.typeName } : {}),
      n: row.n,
      example: location(row.example),
      evidence: evidence(row.evidence),
    }));
  }
}

const STALE_INDEX_HINT =
  "the index predates the identifier table (migration 033). Reindex the project to populate it " +
  "(get_index_status's drift warning names the command); until then the report is empty, not clean.";

const MISSING_TABLE_WARNING = `cg_identifiers does not exist: ${STALE_INDEX_HINT}`;

function scopeOf(req: Pick<GetOntologyReportRequest, "pathPattern" | "language">): GetOntologyReportResponse["scope"] {
  return {
    pathPrefix: pathPatternPrefix(req.pathPattern),
    ...(req.language ? { language: req.language.trim().toLowerCase() } : {}),
  };
}
