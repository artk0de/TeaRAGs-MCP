/**
 * NamingLexiconOps — the query behind `get_naming_lexicon`
 * (bd tea-rags-mcp-4p3sb.11): how THIS project names values of a type, values
 * bound to a call, and a concept, and a verdict per draft name.
 *
 * Lives in `api/internal` because it bridges three owners: the codegraph's
 * `cg_identifiers` reads (DuckDB, via the pool), the explore semantic strategy
 * (concept mode, in-process), and the pure lexicon logic in
 * `domains/explore/naming-lexicon`. The language descriptor's naming facts
 * (casing per role, non-concept types) arrive injected as a map, so neither this
 * class nor the lexicon imports the language domain.
 *
 * Pipeline — every stage is ONE store read, bounded by the resolved scope:
 *
 *   1. Scope. `pathPattern`'s literal prefix; under 5 supporting rows → its
 *      parent directory, then the project. Support = rows of the asked types
 *      (`countIdentifiers`), else rows bound to the drafts' callees, else all
 *      rows in scope.
 *   2. Language. The request's, else the scope's dominant file language. Its
 *      descriptor supplies the canonical casing per role and the non-concept
 *      types, which leave `byType`.
 *   3. byType. The type aggregate (persisted sources + the store's call-return
 *      join), then the `name-inferred` stage computed here and never written: a
 *      name typed ≥ 3 times in scope with one type holding ≥ 80% of those rows
 *      lends that type to its untyped rows, counted apart in `evidence`.
 *   4. byCallee. Rows bound to a draft's callee, for drafts with no type.
 *   5. Concept. Semantic search of the concept alone (dense, production,
 *      the language, L2 domain widened under 5 holders) → terms. Any failure
 *      but an input error → a notice, the other stages still answer.
 *   6. Names. The project shape prior (a bounded sample) and return verbs
 *      license fallbacks; homonymy and collision are evidence; the verdict is
 *      `judgeDraftName`.
 *
 * An index whose graph has files but whose identifier table is empty predates
 * migration 033 → `driftWarning` naming the reindex, not a silent empty answer.
 */

import type { GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import type {
  GraphDbClient,
  IdentifierBoundCallee,
  IdentifierCalleeAggregateRow,
  IdentifierDeclarationKind,
  IdentifierLanguageCountRow,
  IdentifierTypeAggregateRow,
} from "../../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type {
  IdentifierCasing,
  IdentifierNamingConvention,
  IdentifierRole,
} from "../../../contracts/types/language.js";
import {
  detectIdentifierCasing,
  extractConceptTerms,
  isNonConceptType,
  judgeDraftName,
  shapeDistribution,
  splitIdentifierWords,
  type ConceptTerm,
  type ConceptTermHolder,
  type NamingByCalleeRow,
  type NamingByTypeRow,
  type NamingReturnVerbShare,
  type NamingShapeDistribution,
  type NamingShapeRow,
} from "../../../domains/explore/naming-lexicon/index.js";
import type { CollectionRegistry } from "../../../domains/maintenance/registry/index.js";
import { resolvePhysicalCollection } from "../../../infra/collection-name.js";
import { InputValidationError, InvalidParameterError, MissingArgumentError } from "../../errors.js";
import type { ExploreResponse, SemanticSearchRequest } from "../../public/dto/explore.js";
import type {
  NamingLexiconCalleeEntry,
  NamingLexiconDraftName,
  NamingLexiconEvidenceSource,
  NamingLexiconKindProfile,
  NamingLexiconNameVerdict,
  NamingLexiconRequest,
  NamingLexiconResult,
  NamingLexiconTypeEntry,
} from "../../public/dto/naming-lexicon.js";
import { resolveCollection } from "../collection-resolver.js";

/** A scope with fewer supporting rows widens. */
const MIN_SCOPE_SUPPORT = 5;
/** Names listed per kind. */
const TOP_NAMES_PER_KIND = 5;
/** `name-inferred`: a name needs this many typed rows … */
const NAME_INFERENCE_MIN_TYPED = 3;
/** … and one type holding this share of them. */
const NAME_INFERENCE_DOMINANCE = 0.8;
/** Rows sampled for the project shape prior. */
const SHAPE_PRIOR_SAMPLE = 5000;
const CONFIDENCE_SUPPORT = 20;
/** Concept search: holders under the L2 domain below this widen to the project. */
const MIN_CONCEPT_HOLDERS = 5;
const CONCEPT_SEARCH_LIMIT = 30;
const CONCEPT_RERANK = { custom: { similarity: 0.7, chunkFanIn: 0.15, fanIn: 0.15 } };
const CONCEPT_FIELDS = ["symbolId", "relativePath", "parentSymbolId"];
/** Casing when neither a descriptor nor the observed names decide one. */
const FALLBACK_CASING: IdentifierCasing = "snake";

export const NAMING_LEXICON_DRIFT_WARNING =
  "cg_identifiers is empty while the codegraph holds files — the index predates the identifier table; " +
  "reindex with --force to populate it";

/** The explore operation concept mode runs in-process. */
export interface NamingLexiconExplore {
  semanticSearch: (request: SemanticSearchRequest) => Promise<ExploreResponse>;
}

export interface NamingLexiconOpsDeps {
  pool: Pick<GraphDbClientPool, "acquireReader">;
  collectionRegistry: CollectionRegistry;
  resolveActiveCollection?: (collectionName: string) => Promise<PhysicalCollectionName>;
  explore: NamingLexiconExplore;
  /** `LanguageCapability.naming` per language, from the language factory. */
  namingConventions: ReadonlyMap<string, IdentifierNamingConvention>;
}

type IdentifierReader = Pick<
  GraphDbClient,
  | "aggregateIdentifiersByType"
  | "aggregateIdentifiersByCallee"
  | "aggregateIdentifiersByName"
  | "anchorIdentifierTypes"
  | "identifierNameTypes"
  | "existingSymbolShortNames"
  | "countIdentifiers"
  | "identifierLanguageCounts"
  | "sampleIdentifierShapes"
  | "hasData"
>;

/** One byType row after recovery: a store row or a `name-inferred` one. */
interface LexiconTypeRow {
  typeName: string;
  kind: IdentifierDeclarationKind;
  name: string;
  typeSource: NamingLexiconEvidenceSource;
  n: number;
  exampleOwner: string;
}

/** The scope the answer was read from, and what its support stage already read. */
interface ResolvedScope {
  prefix: string;
  support: number;
  calleeRows?: IdentifierCalleeAggregateRow[];
}

/** Casing per declaration kind: a `return` row names a method. */
type KindCasing = (kind: IdentifierDeclarationKind) => IdentifierCasing;

const KIND_ROLE: Record<IdentifierDeclarationKind, IdentifierRole> = {
  param: "param",
  local: "local",
  field: "field",
  return: "method",
};

export class NamingLexiconOps {
  constructor(private readonly deps: NamingLexiconOpsDeps) {}

  async getNamingLexicon(req: NamingLexiconRequest): Promise<NamingLexiconResult> {
    validateRequest(req);
    const { collectionName } = resolveCollection(this.deps.collectionRegistry, req);
    const active = this.deps.resolveActiveCollection
      ? await this.deps
          .resolveActiveCollection(collectionName)
          .catch(() => resolvePhysicalCollection(collectionName, []))
      : resolvePhysicalCollection(collectionName, []);

    let handle: { graphDb: GraphDbClient };
    try {
      handle = await this.deps.pool.acquireReader(active);
    } catch (error) {
      return {
        scope: "",
        byType: [],
        names: [],
        notices: [`codegraph store unavailable: ${errorMessage(error)}`],
      };
    }
    try {
      return await this.answer(handle.graphDb, req);
    } finally {
      await handle.graphDb.close().catch(() => undefined);
    }
  }

  private async answer(graphDb: IdentifierReader, req: NamingLexiconRequest): Promise<NamingLexiconResult> {
    const drafts = req.names ?? [];
    const notices: string[] = [];

    // 1. Types: asked ∪ anchors' param / return types ∪ drafts' types.
    const anchorTypes =
      req.anchors && req.anchors.length > 0
        ? (await graphDb.anchorIdentifierTypes(req.anchors)).map((row) => row.typeName)
        : [];
    const askedTypes = unique([...(req.types ?? []), ...anchorTypes, ...drafts.flatMap((d) => d.type ?? [])]);
    const draftCallees = uniqueCallees(drafts.flatMap((d) => (d.callee && d.type === undefined ? [d.callee] : [])));

    // 2. Scope (widening), then the language whose descriptor applies there.
    const declared = req.language ? this.deps.namingConventions.get(req.language) : undefined;
    const supportTypes = declared ? conceptTypes(askedTypes, declared) : askedTypes;
    const scope = await resolveScope(graphDb, literalPrefix(req.pathPattern), supportTypes, draftCallees);
    const pathPrefixes = scope.prefix === "" ? undefined : [scope.prefix];

    let { language } = req;
    let projectLanguages: IdentifierLanguageCountRow[] | undefined;
    if (language === undefined) {
      const counts = await graphDb.identifierLanguageCounts({ pathPrefixes });
      if (scope.prefix === "") projectLanguages = counts;
      language = counts.find((c) => c.language !== null)?.language ?? undefined;
    }
    const convention = language ? this.deps.namingConventions.get(language) : undefined;
    const nonConceptTypes = convention?.nonConceptTypes ?? [];

    const driftWarning =
      scope.support === 0 && scope.prefix === "" && (await identifierTableIsStale(graphDb, projectLanguages))
        ? NAMING_LEXICON_DRIFT_WARNING
        : undefined;

    // 3. byType (store aggregate + name-inferred).
    const types = askedTypes.filter((t) => !isNonConceptType(t, nonConceptTypes));
    const typeRows = await readTypeRows(graphDb, types, pathPrefixes);

    // 4. byCallee.
    const calleeRows =
      draftCallees.length === 0
        ? []
        : (scope.calleeRows ?? (await graphDb.aggregateIdentifiersByCallee({ callees: draftCallees, pathPrefixes })));

    const casingFor = kindCasing(convention, [...typeRows, ...calleeRows]);
    const byType = buildTypeEntries(types, typeRows, casingFor);
    const byCallee = draftCallees.map((callee) => buildCalleeEntry(callee, calleeRows, casingFor));

    // 5. Concept.
    let conceptTerms: ConceptTerm[] | undefined;
    // validateRequest guarantees a language whenever a concept is set.
    if (req.concept && req.language) {
      try {
        conceptTerms = await this.conceptTerms(req, req.concept, req.language);
      } catch (error) {
        if (error instanceof InputValidationError) throw error;
        notices.push(`concept step skipped: ${errorMessage(error)}`);
      }
    }

    // 6. Names.
    const names =
      drafts.length === 0
        ? []
        : await judgeDrafts(graphDb, drafts, {
            typeRows,
            calleeRows,
            casingFor,
            nonConceptTypes,
            conceptTerms,
            pathPrefixes,
          });

    return {
      scope: scope.prefix,
      ...(language ? { language } : {}),
      byType,
      ...(draftCallees.length > 0 ? { byCallee } : {}),
      ...(conceptTerms ? { concept: { terms: conceptTerms } } : {}),
      names,
      ...(notices.length > 0 ? { notices } : {}),
      ...(driftWarning ? { driftWarning } : {}),
    };
  }

  /** Concept holders under the L2 domain of `pathPattern`, widened to the project under 5 holders. */
  private async conceptTerms(req: NamingLexiconRequest, concept: string, language: string): Promise<ConceptTerm[]> {
    const search = async (pathPattern: string | undefined): Promise<ConceptTermHolder[]> => {
      const response = await this.deps.explore.semanticSearch({
        ...collectionRef(req),
        query: concept,
        language,
        ...(pathPattern ? { pathPattern } : {}),
        filter: { presets: "production" },
        rerank: CONCEPT_RERANK,
        limit: CONCEPT_SEARCH_LIMIT,
        metaOnly: true,
        fields: CONCEPT_FIELDS,
      });
      return response.results.flatMap((r) => {
        const symbolId = r.payload?.symbolId;
        const relativePath = r.payload?.relativePath;
        return typeof symbolId === "string" && typeof relativePath === "string"
          ? [{ symbolId, relativePath, score: r.score }]
          : [];
      });
    };
    const domain = domainPattern(literalPrefix(req.pathPattern));
    let holders = await search(domain);
    if (domain !== undefined && holders.length < MIN_CONCEPT_HOLDERS) holders = await search(undefined);
    return extractConceptTerms(holders);
  }
}

// ── request ──────────────────────────────────────────────────────────────

function validateRequest(req: NamingLexiconRequest): void {
  const asked =
    (req.types?.length ?? 0) > 0 ||
    (req.anchors?.length ?? 0) > 0 ||
    (req.names?.length ?? 0) > 0 ||
    (req.concept ?? "").length > 0;
  if (!asked) throw new MissingArgumentError(["types | anchors | concept | names"]);
  if (req.concept && !req.language) throw new InvalidParameterError("concept", "requires 'language'");
}

function collectionRef(req: NamingLexiconRequest): Pick<SemanticSearchRequest, "collection" | "project" | "path"> {
  return {
    ...(req.collection !== undefined ? { collection: req.collection } : {}),
    ...(req.project !== undefined ? { project: req.project } : {}),
    ...(req.path !== undefined ? { path: req.path } : {}),
  };
}

// ── scope ────────────────────────────────────────────────────────────────

/** The literal rel_path prefix of a glob: everything before its first `* ? { [`. */
export function literalPrefix(pathPattern: string | undefined): string {
  if (!pathPattern) return "";
  const cut = pathPattern.search(/[*?{[]/);
  return (cut === -1 ? pathPattern : pathPattern.slice(0, cut)).replace(/^\.?\//, "");
}

/** The parent directory of a prefix, with its trailing `/`; `""` at the top. */
function parentPrefix(prefix: string): string {
  const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? "" : trimmed.slice(0, slash + 1);
}

/** The L2 domain glob of a prefix: its first two complete directories (`app/services/**`). */
function domainPattern(prefix: string): string | undefined {
  const directories = prefix
    .slice(0, prefix.lastIndexOf("/") + 1)
    .split("/")
    .filter(Boolean);
  if (directories.length === 0) return undefined;
  return `${directories.slice(0, 2).join("/")}/**`;
}

/** The first of prefix, parent, project whose support reaches {@link MIN_SCOPE_SUPPORT}; the project otherwise. */
async function resolveScope(
  graphDb: IdentifierReader,
  prefix: string,
  types: readonly string[],
  callees: readonly IdentifierBoundCallee[],
): Promise<ResolvedScope> {
  const levels = unique([prefix, parentPrefix(prefix), ""]);
  let last: ResolvedScope = { prefix: "", support: 0 };
  for (const level of levels) {
    last = await supportAt(graphDb, level, types, callees);
    if (last.support >= MIN_SCOPE_SUPPORT) return last;
  }
  return last;
}

async function supportAt(
  graphDb: IdentifierReader,
  prefix: string,
  types: readonly string[],
  callees: readonly IdentifierBoundCallee[],
): Promise<ResolvedScope> {
  const pathPrefixes = prefix === "" ? undefined : [prefix];
  if (types.length > 0) return { prefix, support: await graphDb.countIdentifiers({ types, pathPrefixes }) };
  if (callees.length > 0) {
    const calleeRows = await graphDb.aggregateIdentifiersByCallee({ callees, pathPrefixes });
    return { prefix, support: sum(calleeRows), calleeRows };
  }
  return { prefix, support: sum(await graphDb.identifierLanguageCounts({ pathPrefixes })) };
}

/**
 * True when the identifier table is empty while the graph holds files — an
 * index written before migration 033. Called only for a project-wide answer
 * with no support; `projectLanguages` = the project's language counts, when
 * already read.
 */
async function identifierTableIsStale(
  graphDb: IdentifierReader,
  projectLanguages: readonly IdentifierLanguageCountRow[] | undefined,
): Promise<boolean> {
  const counts = projectLanguages ?? (await graphDb.identifierLanguageCounts({}));
  return counts.length === 0 && (await graphDb.hasData());
}

// ── byType ───────────────────────────────────────────────────────────────

function conceptTypes(types: readonly string[], convention: IdentifierNamingConvention): string[] {
  return types.filter((t) => !isNonConceptType(t, convention.nonConceptTypes));
}

async function readTypeRows(
  graphDb: IdentifierReader,
  types: readonly string[],
  pathPrefixes: string[] | undefined,
): Promise<LexiconTypeRow[]> {
  if (types.length === 0) return [];
  const stored: LexiconTypeRow[] = (await graphDb.aggregateIdentifiersByType({ types, pathPrefixes })).map(
    (row: IdentifierTypeAggregateRow) => ({ ...row }),
  );
  if (stored.length === 0) return stored;
  return [...stored, ...(await nameInferredRows(graphDb, stored, new Set(types), pathPrefixes))];
}

/**
 * The `name-inferred` stage: every name the type rows carry, read once in scope
 * with all its types; a name typed ≥ 3 times with one type holding ≥ 80% of
 * those rows lends that type to its untyped rows — when it is an asked type.
 */
async function nameInferredRows(
  graphDb: IdentifierReader,
  typeRows: readonly LexiconTypeRow[],
  types: ReadonlySet<string>,
  pathPrefixes: string[] | undefined,
): Promise<LexiconTypeRow[]> {
  const byName = await graphDb.aggregateIdentifiersByName({
    names: unique(typeRows.map((r) => r.name)),
    pathPrefixes,
  });
  const typedByName = new Map<string, Map<string, number>>();
  for (const row of byName) {
    if (row.typeName === null) continue;
    const perType = typedByName.get(row.name) ?? new Map<string, number>();
    perType.set(row.typeName, (perType.get(row.typeName) ?? 0) + row.n);
    typedByName.set(row.name, perType);
  }
  const inferred: LexiconTypeRow[] = [];
  for (const row of byName) {
    if (row.typeName !== null) continue;
    const lent = dominantType(typedByName.get(row.name));
    if (lent === undefined || !types.has(lent)) continue;
    inferred.push({
      typeName: lent,
      kind: row.kind,
      name: row.name,
      typeSource: "name-inferred",
      n: row.n,
      exampleOwner: row.exampleOwner,
    });
  }
  return inferred;
}

function dominantType(perType: ReadonlyMap<string, number> | undefined): string | undefined {
  if (!perType) return undefined;
  let total = 0;
  let best: [string, number] | undefined;
  for (const entry of perType) {
    total += entry[1];
    if (!best || entry[1] > best[1]) best = entry;
  }
  if (!best || total < NAME_INFERENCE_MIN_TYPED) return undefined;
  return best[1] / total >= NAME_INFERENCE_DOMINANCE ? best[0] : undefined;
}

function buildTypeEntries(
  types: readonly string[],
  rows: readonly LexiconTypeRow[],
  casingFor: KindCasing,
): NamingLexiconTypeEntry[] {
  const entries: NamingLexiconTypeEntry[] = [];
  for (const type of types) {
    const typeRows = rows.filter((r) => r.typeName === type);
    if (typeRows.length === 0) continue;
    const evidence: Partial<Record<NamingLexiconEvidenceSource, number>> = {};
    for (const row of typeRows) evidence[row.typeSource] = (evidence[row.typeSource] ?? 0) + row.n;
    const total = sum(typeRows);
    entries.push({
      type,
      ...kindProfile(typeRows, (kind) => ({ kind, casing: casingFor(kind), typeName: type })),
      confidence: Math.min(1, (total / CONFIDENCE_SUPPORT) ** 2),
      evidence,
    });
  }
  return entries.sort((a, b) => totalEvidence(b) - totalEvidence(a));
}

function totalEvidence(entry: NamingLexiconTypeEntry): number {
  return Object.values(entry.evidence).reduce((acc, n) => acc + (n ?? 0), 0);
}

/** Top names and shape shares per kind over rows the context classifies. */
function kindProfile(
  rows: readonly (NamingShapeRow & { kind: IdentifierDeclarationKind })[],
  context: (kind: IdentifierDeclarationKind) => Parameters<typeof shapeDistribution>[1],
): NamingLexiconKindProfile {
  const kinds: NamingLexiconKindProfile["kinds"] = {};
  const shapes: NamingLexiconKindProfile["shapes"] = {};
  for (const kind of unique(rows.map((r) => r.kind))) {
    const kindRows = rows.filter((r) => r.kind === kind);
    const perName = new Map<string, number>();
    for (const row of kindRows) perName.set(row.name, (perName.get(row.name) ?? 0) + row.n);
    kinds[kind] = [...perName]
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
      .slice(0, TOP_NAMES_PER_KIND);
    shapes[kind] = shapeDistribution(kindRows, context(kind)).shares;
  }
  return { kinds, shapes };
}

// ── byCallee ─────────────────────────────────────────────────────────────

/** A requested callee without a receiver matches every receiver — as the store reads it. */
function matchesCallee(row: IdentifierCalleeAggregateRow, callee: IdentifierBoundCallee): boolean {
  return row.member === callee.member && (callee.receiver === undefined || row.receiver === callee.receiver);
}

function buildCalleeEntry(
  callee: IdentifierBoundCallee,
  rows: readonly IdentifierCalleeAggregateRow[],
  casingFor: KindCasing,
): NamingLexiconCalleeEntry {
  const calleeRows = rows.filter((r) => matchesCallee(r, callee));
  return {
    member: callee.member,
    ...(callee.receiver !== undefined ? { receiver: callee.receiver } : {}),
    ...kindProfile(calleeRows, (kind) => ({ kind, casing: casingFor(kind), callee })),
  };
}

// ── names ────────────────────────────────────────────────────────────────

interface DraftJudgementContext {
  typeRows: readonly LexiconTypeRow[];
  calleeRows: readonly IdentifierCalleeAggregateRow[];
  casingFor: KindCasing;
  nonConceptTypes: readonly string[];
  conceptTerms?: ConceptTerm[];
  pathPrefixes: string[] | undefined;
}

async function judgeDrafts(
  graphDb: IdentifierReader,
  drafts: readonly NamingLexiconDraftName[],
  ctx: DraftJudgementContext,
): Promise<NamingLexiconNameVerdict[]> {
  const draftNames = unique(drafts.map((d) => d.name));
  const [homonyms, collisions, sample] = await Promise.all([
    graphDb.identifierNameTypes(draftNames),
    graphDb.existingSymbolShortNames(draftNames),
    graphDb.sampleIdentifierShapes({ pathPrefixes: ctx.pathPrefixes, limit: SHAPE_PRIOR_SAMPLE }),
  ]);
  const prior = projectShapePrior(sample, ctx.casingFor);
  const taken = new Set(collisions);

  return drafts.map((draft) => {
    const kind = draft.kind ?? "local";
    const verdict = judgeDraftName({
      name: draft.name,
      kind,
      typeName: draft.type,
      casing: ctx.casingFor(kind),
      nonConceptTypes: ctx.nonConceptTypes,
      callee: draft.callee,
      byTypeRows: draft.type === undefined ? undefined : byTypeRowsFor(draft.type, ctx.typeRows),
      byCalleeRows: draft.callee ? byCalleeRowsFor(draft.callee, ctx.calleeRows) : undefined,
      conceptTerms: ctx.conceptTerms,
      projectShapePrior: prior.shapes,
      projectReturnVerbs: prior.returnVerbs,
    });
    const nameRows = homonyms.filter((r) => r.name === draft.name);
    const example =
      (verdict.verdict === "MISFIT" ? verdict.holder : undefined) ??
      [...ctx.typeRows, ...ctx.calleeRows].find((r) => r.name === draft.name)?.exampleOwner;
    return {
      name: draft.name,
      ...verdict,
      evidence: {
        n: sum(nameRows),
        ...(example !== undefined ? { example } : {}),
        boundTypes: new Set(nameRows.flatMap((r) => (r.typeName === null ? [] : [r.typeName]))).size,
        collision: taken.has(draft.name),
      },
    };
  });
}

/** The draft type's rows merged per (kind, name) across type sources. */
function byTypeRowsFor(typeName: string, rows: readonly LexiconTypeRow[]): NamingByTypeRow[] {
  const merged = new Map<string, NamingByTypeRow>();
  for (const row of rows) {
    if (row.typeName !== typeName) continue;
    const key = `${row.kind}\u0000${row.name}`;
    const prev = merged.get(key);
    merged.set(key, {
      kind: row.kind,
      name: row.name,
      n: (prev?.n ?? 0) + row.n,
      exampleOwner: prev && prev.exampleOwner < row.exampleOwner ? prev.exampleOwner : row.exampleOwner,
    });
  }
  return [...merged.values()];
}

function byCalleeRowsFor(
  callee: IdentifierBoundCallee,
  rows: readonly IdentifierCalleeAggregateRow[],
): NamingByCalleeRow[] {
  return rows
    .filter((r) => matchesCallee(r, callee))
    .map((r) => ({
      member: r.member,
      // The store matched any receiver for a receiverless callee; the verdict
      // compares receivers, so the rows answer under the callee as asked.
      ...(callee.receiver !== undefined ? { receiver: callee.receiver } : {}),
      kind: r.kind,
      name: r.name,
      n: r.n,
      exampleOwner: r.exampleOwner,
      ...(r.typeName !== undefined ? { typeName: r.typeName } : {}),
    }));
}

/**
 * The project prior over a bounded sample of the scope's evidence-carrying
 * rows: shape shares per kind (each kind in its role's casing) and the verbs
 * of its `VERB_TYPE` returns.
 */
function projectShapePrior(
  sample: Awaited<ReturnType<IdentifierReader["sampleIdentifierShapes"]>>,
  casingFor: KindCasing,
): {
  shapes: Partial<Record<IdentifierDeclarationKind, NamingShapeDistribution>>;
  returnVerbs: NamingReturnVerbShare[];
} {
  const shapes: Partial<Record<IdentifierDeclarationKind, NamingShapeDistribution>> = {};
  const rows = sample.map((r) => ({
    kind: r.kind,
    name: r.name,
    n: r.n,
    ...(r.typeName !== null ? { typeName: r.typeName } : {}),
    ...(r.boundMember !== null
      ? { callee: { member: r.boundMember, ...(r.boundReceiver !== null ? { receiver: r.boundReceiver } : {}) } }
      : {}),
  }));
  for (const kind of unique(rows.map((r) => r.kind))) {
    shapes[kind] = shapeDistribution(
      rows.filter((r) => r.kind === kind),
      { kind, casing: casingFor(kind) },
    );
  }
  const verbCounts = new Map<string, number>();
  let verbTotal = 0;
  for (const row of rows) {
    if (row.kind !== "return") continue;
    const [shape] = shapeDistribution([row], { kind: "return", casing: casingFor("return") }).shares;
    if (shape?.shape !== "VERB_TYPE") continue;
    const verb = splitIdentifierWords(row.name)[0];
    verbCounts.set(verb, (verbCounts.get(verb) ?? 0) + row.n);
    verbTotal += row.n;
  }
  const returnVerbs = [...verbCounts].map(([verb, n]) => ({ verb, share: n / verbTotal }));
  return { shapes, returnVerbs };
}

// ── casing ───────────────────────────────────────────────────────────────

/**
 * The canonical casing of each kind's role from the language descriptor. With
 * no descriptor (language unknown), the casing most observed names are written
 * in; `snake` when no name decides.
 */
function kindCasing(
  convention: IdentifierNamingConvention | undefined,
  observed: readonly { name: string; n: number }[],
): KindCasing {
  if (convention) return (kind) => convention.casing[KIND_ROLE[kind]][0] ?? FALLBACK_CASING;
  const counts = new Map<IdentifierCasing, number>();
  for (const row of observed) {
    const casing = detectIdentifierCasing(row.name);
    if (casing) counts.set(casing, (counts.get(casing) ?? 0) + row.n);
  }
  let best: IdentifierCasing = FALLBACK_CASING;
  let bestN = 0;
  for (const [casing, n] of counts) {
    if (n > bestN) [best, bestN] = [casing, n];
  }
  return () => best;
}

// ── helpers ──────────────────────────────────────────────────────────────

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function uniqueCallees(callees: readonly IdentifierBoundCallee[]): IdentifierBoundCallee[] {
  const seen = new Map<string, IdentifierBoundCallee>();
  for (const callee of callees) seen.set(`${callee.member}\u0000${callee.receiver ?? ""}`, callee);
  return [...seen.values()];
}

function sum(rows: readonly { n: number }[]): number {
  return rows.reduce((acc, r) => acc + r.n, 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
