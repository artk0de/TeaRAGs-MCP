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
 *   2. Language — the one the answer (and the drafts) are written in. The
 *      request's; else, given a `pathPattern`, the dominant file language of the
 *      REQUESTED pattern (literal prefix + pinned extension), not of the widened
 *      scope — the pinned extension project-wide, then the project, only when
 *      that pattern holds no rows (so up to three reads); else, with no
 *      pattern, the dominant file language of the evidence rows the request
 *      names (asked / anchor / draft types and draft callees, weighted by n);
 *      else the language most type drafts' paths are written in; else the
 *      project's. Its descriptor supplies the drafts' casing per role
 *      and the non-concept types, which leave `byType`.
 *   3. byType. The type aggregate (persisted sources + the store's call-return
 *      join), then the `name-inferred` stage computed here and never written: a
 *      name typed ≥ 3 times in scope with one type holding ≥ 80% of those rows
 *      lends that type to its untyped rows, counted apart in `evidence`. Each
 *      store row carries `sameTypeSiblingN` (rows beside a second binding of
 *      the type in their owner), which confirms a QUALIFIED name; a
 *      `name-inferred` row has none and is classified lexically.
 *   4. byCallee. Rows bound to a draft's callee, for drafts with no type.
 *   5. Concept. Semantic search of the concept alone (dense, production,
 *      the language, L2 domain widened under 5 holders) → terms. Any failure
 *      but an input error → a notice, the other stages still answer.
 *   6. Names. The project shape prior (a bounded sample) and return verbs
 *      license fallbacks; homonymy and collision are evidence; the verdict is
 *      `judgeDraftName`.
 *   7. Type names (`kind: "type"` drafts, bd tea-rags-mcp-vi0wx). One read per
 *      TYPE NAMESPACE of the project's type and constant declarations
 *      (`cg_type_declarations`, production files): the draft's path language
 *      and every language sharing its `typeNamespace` (bd tea-rags-mcp-icuxg),
 *      so collisions and evidence never cross into a language the draft cannot
 *      import from. A draft judged off the answer's language names its own
 *      (`names[].language`). → roles, the modifier vocabulary and head spellings;
 *      per draft a concept search (its `concept`, the request's, else its own
 *      words) samples the type names nearest its meaning for term alignment;
 *      the verdict is `judgeTypeDraft`. A failed search is a notice, the draft
 *      is still judged.
 *
 * Every evidence read honours the answer's `excludePaths`
 * (`NamingLexiconEvidenceScope`, diff mode's changed files) and, once the
 * answer's language is known, its LANGUAGE NAMESPACE (bd tea-rags-mcp-0qaht):
 * the language and every language sharing its `typeNamespace` — the set type
 * drafts are judged in — so a TypeScript draft reads TypeScript and JavaScript
 * rows and never a Ruby local. The reader is wrapped once per scope
 * ({@link scopedEvidence}), so no stage can read around it.
 *
 * Every evidence row (byType, byCallee, the shape prior's sample) is read split
 * by its file language and classified in THAT language's casing — a mixed Ruby
 * + TypeScript project holds `tax_automation_document` and
 * `taxAutomationDocument` for one type, and both are EXACT. A row whose language
 * has no descriptor takes the casing most observed names are written in; a row
 * whose file has no language, the answer's casing.
 *
 * An index whose graph has files but whose identifier table is empty predates
 * migration 033 → `driftWarning` naming the reindex, not a silent empty answer.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import type { AddedLineRange } from "../../../adapters/vcs/git/git-cli/client.js";
import type {
  GraphDbClient,
  IdentifierBoundCallee,
  IdentifierCalleeAggregateRow,
  IdentifierDeclarationKind,
  IdentifierLanguageCountQuery,
  IdentifierLanguageCountRow,
  IdentifierRow,
  IdentifierTypeAggregateRow,
  IdentifierTypeMultiplicity,
  MethodHeadWordRow,
  TypeNameRow,
} from "../../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type {
  IdentifierCasing,
  IdentifierNamingConvention,
  IdentifierRole,
} from "../../../contracts/types/language.js";
import type { WorkingTree } from "../../../contracts/types/working-tree.js";
import type { WorkingTreeOverlay } from "../../../domains/explore/index.js";
import {
  detectIdentifierCasing,
  extractConceptTerms,
  filePrimaryDeclaration,
  isNonConceptType,
  judgeDraftName,
  judgeGenericNames,
  judgeTypeDraft,
  mergedHolders,
  mergedSameTypeSiblingN,
  MIN_NULL_SAMPLE_HEADS,
  nullHeadSample,
  nullSimilarityDistribution,
  reexportTwins,
  shapeDistribution,
  singleCarrierHeadFiles,
  splitIdentifierWords,
  TYPE_DRAFT_KINDS,
  typeDraftAlignmentWords,
  typeDraftEvidence,
  typeDraftPopulation,
  typeFamilyMembers,
  typeNameEvidence,
  typeNameHeadCarriers,
  typeNameLastSegment,
  typeNameWords,
  withFamilyAnalogues,
  type ConceptTerm,
  type ConceptTermHolder,
  type FileLocalBindings,
  type JudgedGenericName,
  type NamingByCalleeRow,
  type NamingByTypeRow,
  type NamingReturnVerbShare,
  type NamingShapeDistribution,
  type NamingShapeRow,
  type NamingVerdict,
  type ReexportTwins,
  type TypeDraftJudgementInput,
  type TypeDraftPopulation,
  type TypeNameEvidence,
} from "../../../domains/explore/naming-lexicon/index.js";
import type { CollectionRegistry } from "../../../domains/maintenance/registry/index.js";
import { resolvePhysicalCollection } from "../../../infra/collection-name.js";
import { pathPatternLiteralPrefix } from "../../../infra/path-pattern.js";
import { cosine } from "../../../infra/vector-math.js";
import { InputValidationError, InvalidParameterError, MissingArgumentError } from "../../errors.js";
import type { ExploreResponse, FindSymbolRequest, SemanticSearchRequest } from "../../public/dto/explore.js";
import type { IndexMetrics } from "../../public/dto/metrics.js";
import type {
  NamingLexiconCalleeEntry,
  NamingLexiconDraftName,
  NamingLexiconEvidenceScope,
  NamingLexiconEvidenceSource,
  NamingLexiconKindProfile,
  NamingLexiconNameVerdict,
  NamingLexiconRequest,
  NamingLexiconResult,
  NamingLexiconTypeDraft,
  NamingLexiconTypeEntry,
  NamingLexiconTypeNameHead,
  NamingReviewFinding,
  NamingReviewNote,
  NamingReviewNotJudgedEntry,
  NamingReviewResult,
} from "../../public/dto/naming-lexicon.js";
import { resolveIndexedWorkingTree, type IndexExistenceCheck } from "../collection-resolver.js";
import { DIFF_FILE_CAP, readDiffScope, readTreeLag } from "./diff-scope-reader.js";
import { readUntypedMethodEvidence, type MethodHeadWordMemo } from "./naming-lexicon-method-evidence.js";
import type {
  NamingReviewExtractor,
  NamingReviewFileDeclarations,
  NamingReviewFileExtractor,
} from "./naming-review-extraction.js";
import {
  GENERIC_NAME_BAR,
  ontologyNonProductionPaths,
  ontologyReportQuery,
  ontologyRowCasing,
  type OntologyLanguageProfile,
} from "./ontology-report-ops.js";

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

/**
 * Diff mode: characters of a type declaration's enclosing chunk its concept
 * query carries (spec §4.1) — the head of the chunk, where the declaration and
 * its first members are; the embedding reads a bounded query anyway.
 */
const DIFF_CONCEPT_CODE_CHARS = 1500;
/** Diff mode: how many not-judged entries `notJudgedNames` lists; `notJudgedBy` counts them all. */
const NOT_JUDGED_NAME_CAP = 50;

/** Collided symbol ids a value / return draft's evidence lists — as many as a head alternative's example types. */
const MAX_COLLISION_EXAMPLES = 3;
/** The symbol lookup behind them: enough hits that the excluded file's own and a near-name cannot crowd them out. */
const COLLISION_LOOKUP_LIMIT = 10;
const COLLISION_LOOKUP_FIELDS = ["symbolId", "relativePath"];

/** Declaration kinds the type-name read loads: the type-level kinds and constants, one read for both populations. */
const TYPE_NAME_READ_KINDS = [...TYPE_DRAFT_KINDS, "constant"] as const;

export const NAMING_LEXICON_TYPE_DECLARATIONS_EMPTY =
  "cg_type_declarations is empty — type and constant names are judged without project evidence; " +
  "recompute the codegraph (--force-enrichments codegraph) to populate it";

export const NAMING_LEXICON_DRIFT_WARNING =
  "cg_identifiers is empty while the codegraph holds files — the index predates the identifier table; " +
  "reindex with --force to populate it";

/**
 * The embedding port head alignment by meaning reads (bd tea-rags-mcp-433d2):
 * a batch of short words in, one vector each out — the shape of
 * `EmbeddingProvider#embedBatch`, which the factory injects.
 */
export interface NamingLexiconEmbeddings {
  embedBatch: (texts: string[]) => Promise<{ embedding: number[] }[]>;
}

/** The explore operations naming runs in-process: concept search, and the label thresholds of the index. */
export interface NamingLexiconExplore {
  semanticSearch: (request: SemanticSearchRequest) => Promise<ExploreResponse>;
  /**
   * The symbols a colliding value / return draft collides with (bd
   * tea-rags-mcp-xsxkr): their ids on `evidence.collisions`. Absent → the
   * collision is reported without them.
   */
  findSymbol?: (request: FindSymbolRequest) => Promise<ExploreResponse>;
  /**
   * Absent → no head is established by usage (bd tea-rags-mcp-433d2). Handed
   * the request's RESOLVED collection, which wins over the path (bd tea-rags-mcp-2kplu).
   */
  getIndexMetrics?: (path: string, collection?: string) => Promise<IndexMetrics>;
}

export interface NamingLexiconOpsDeps {
  pool: Pick<GraphDbClientPool, "acquireReader">;
  collectionRegistry: CollectionRegistry;
  resolveActiveCollection?: (collectionName: string) => Promise<PhysicalCollectionName>;
  explore: NamingLexiconExplore;
  /** `LanguageCapability.naming` per language, from the language factory. */
  namingConventions: ReadonlyMap<string, IdentifierNamingConvention>;
  /**
   * The ontology report's language profiles (`ontologyLanguageProfiles()`): with
   * them, a draft whose name the report judges generic in scope carries
   * `genericName`. Absent → no generic judgement is read.
   */
  ontologyLanguages?: readonly OntologyLanguageProfile[];
  /**
   * Diff mode (`changes` / `files`): a changed file's declarations from its
   * working-tree text (`createNamingReviewExtractor`). Absent → every changed
   * file counts as not judged.
   */
  extractDeclarations?: NamingReviewExtractor;
  /**
   * Type drafts: embeds the draft's head and its anchored candidate heads, so
   * a synonym head (`IndexNumbers`) gets the project's word (`metrics`).
   * Absent → type drafts are judged without head alignment by meaning.
   */
  embeddings?: NamingLexiconEmbeddings;
  /**
   * Measures the tree the request reads against its index (bd tea-rags-mcp-xi2r9).
   * Present → every answer carries `workingTree`; absent (unit wiring) → none.
   */
  workingTreeOverlay?: Pick<WorkingTreeOverlay, "view">;
  /**
   * Whether the resolved index exists — a read of one that does not is refused
   * with the typed not-found error (live round-3 D3, `resolveIndexedWorkingTree`).
   * Absent (unit wiring): not checked.
   */
  indexExists?: IndexExistenceCheck;
}

/** Diff mode: one changed file's added lines, its working-tree text and its declarations. */
interface DiffFile {
  relPath: string;
  ranges: readonly AddedLineRange[];
  text: string;
  declarations: NamingReviewFileDeclarations;
}

/** Diff mode's reads: the reviewed files, the evidence they are excluded from, and the files not judged. */
interface DiffRead {
  /** The working tree the change was read from. */
  workTree: string;
  base: string;
  /** `base`'s merge-base with HEAD — what the change is read against. */
  mergeBase: string;
  changedFiles: number;
  wholeFiles: number;
  /** The files under the cap — what `excludePaths` carries. */
  files: string[];
  judged: DiffFile[];
  /** Files not judged, and the callables of judged files no draft carries. */
  notJudged: NamingReviewNotJudgedEntry[];
  skipped: number;
  /** What the read could not see: an empty diff names the trees and bases it did not look at. */
  notices: string[];
}

/** One added declaration as a draft, with where it was declared. */
interface ReviewDraft {
  relPath: string;
  line: number;
  language: string;
  kind: string;
  type?: string;
  draft: NamingLexiconValueDraft | NamingLexiconTypeDraft;
}

/**
 * Term-alignment reads — concept searches and head-word embeddings — share one
 * fate per request: the first failure is one notice and stops the later reads,
 * across every judgement the request runs. `vectors` caches the texts already
 * embedded in this request; `nullSimilarities` the null head-pair distribution per population
 * (`null`: the population is too small to measure one).
 */
interface TypeAlignmentState {
  failure?: string;
  vectors?: Map<string, number[]>;
  /** Keyed by {@link typeEvidenceKey}: one distribution per type namespace and population. */
  nullSimilarities?: Map<string, readonly number[] | null>;
  /**
   * The type and constant declarations per type namespace ({@link typeNamespaceKey}),
   * read at most once per request — diff mode's per-language answers of one
   * namespace share the read.
   */
  typeNameRows?: Map<string, Promise<TypeNameRow[]>>;
  /** The method head words (verb lexicon) per evidence scope ({@link MethodHeadWordMemo}), read at most once per request. */
  methodHeadWordRows?: MethodHeadWordMemo["reads"];
  /** The project's index metrics — its label thresholds — read at most once per request. */
  metrics?: Promise<IndexMetrics>;
  /**
   * The file pairs a re-export joins ({@link reexportTwins}), read at most
   * once per request; the promise resolves `undefined` when the file graph is
   * unreadable, and the resolution is final — the collision then stands (bd
   * tea-rags-mcp-89k7k.15).
   */
  reexportTwins?: Promise<ReexportTwins | undefined>;
}

/**
 * One answer's reads: the files every evidence read leaves out (diff mode's
 * changed files, a value draft's own `path`), the request-wide alignment state,
 * and whether a collision's symbols are looked up (names mode only — a
 * review's findings carry no evidence).
 */
interface AnswerContext {
  alignment: TypeAlignmentState;
  excludePaths: readonly string[];
  lookupCollisions: boolean;
}

/** What alignment by meaning hands `judgeTypeDraft`. */
type MeaningAlignment = Pick<TypeDraftJudgementInput, "wordSimilarity" | "nullSimilarities" | "usageEstablishedHeads">;

/** The signal and band whose threshold establishes a head one type carries by usage. */
const FAN_IN_SIGNAL = "codegraph.file.fanIn";
const POPULAR_FAN_IN_LABEL = "popular";

type IdentifierReader = Pick<
  GraphDbClient,
  | "aggregateIdentifiersByType"
  | "aggregateIdentifiersByCallee"
  | "aggregateIdentifiersByName"
  | "anchorIdentifierTypes"
  | "identifierNameTypes"
  | "existingSymbolShortNames"
  | "readMethodHeadWords"
  | "readMethodTailVerbs"
  | "readMethodNamesMatching"
  | "countIdentifiers"
  | "identifierLanguageCounts"
  | "sampleIdentifierShapes"
  | "hasData"
  | "readOntologyReportSummary"
  | "readTypeNameRows"
  | "readFileDependencyGraph"
  | "getFanIn"
  | "getSupertypes"
  | "getSymbolVisibilities"
>;

/**
 * A value draft: `kind` absent or a declaration kind. `owner` is internal (bd
 * tea-rags-mcp-bjfa0): the type a `return` draft is declared in — diff mode's
 * enclosing class, names mode's class at `path` — whose ancestry may already
 * declare the method it names. `fileLocal` is internal too (bd
 * tea-rags-mcp-hzrxn): the declaring file's pre-existing bindings of the
 * draft's role, which diff mode reads off the working-tree text — not a
 * request field.
 */
type NamingLexiconValueDraft = NamingLexiconDraftName & {
  kind?: IdentifierDeclarationKind;
  owner?: string;
  fileLocal?: FileLocalBindings;
};

function isTypeDraft(draft: NamingLexiconDraftName): boolean {
  return draft.kind === "type";
}

/** A `return` draft with no type and no callee: judged by the project's method vocabulary. */
function isUntypedMethodDraft(draft: NamingLexiconValueDraft): boolean {
  return draft.kind === "return" && draft.type === undefined && draft.callee === undefined;
}

/** One byType row after recovery: a store row or a `name-inferred` one. */
interface LexiconTypeRow {
  typeName: string;
  kind: IdentifierDeclarationKind;
  name: string;
  typeSource: NamingLexiconEvidenceSource;
  /** `many` for a collection of the type; absent = one (a `name-inferred` row is one). */
  typeMultiplicity?: IdentifierTypeMultiplicity;
  n: number;
  exampleOwner: string;
  /** The row's file language (null: its file has no language row). */
  language?: string | null;
  /** The casing the row is classified in — its own language's, see {@link rowCasingResolver}. */
  casing?: IdentifierCasing;
  /** Of `n`, the rows beside a second binding of the type (a store row; a `name-inferred` row has none). */
  sameTypeSiblingN?: number;
  /** The distinct owners behind `n` (a store row; a `name-inferred` row has none). */
  holders?: number;
}

/** One byCallee row with the casing it is classified in. */
type LexiconCalleeRow = IdentifierCalleeAggregateRow & { casing?: IdentifierCasing };

/** The scope the answer was read from, and what its support stage already read. */
interface ResolvedScope {
  prefix: string;
  support: number;
  calleeRows?: IdentifierCalleeAggregateRow[];
}

/** Stage 1: the types the request asks about (asked ∪ anchors ∪ drafts') and the drafts' callees. */
interface AskedNamingSet {
  askedTypes: string[];
  draftCallees: IdentifierBoundCallee[];
}

/**
 * Stages 1-2: {@link AskedNamingSet} plus the widened scope it resolved to and
 * the language the answer is written in — with the reads that decided the
 * language kept, so stage 3 can reuse them instead of re-reading.
 */
interface ResolvedNamingScope extends AskedNamingSet {
  scope: ResolvedScope;
  pathPrefixes: string[] | undefined;
  /** byCallee's rows, read before the language was decided — they may have decided it. */
  earlyCalleeRows: IdentifierCalleeAggregateRow[];
  /**
   * Type rows read before the language was decided, when nothing else could
   * decide it; reused verbatim when the namespace scoping re-reads nothing.
   */
  askedTypeRows: LexiconTypeRow[] | undefined;
  language: string | undefined;
  convention: IdentifierNamingConvention | undefined;
  nonConceptTypes: readonly string[];
  /** The project's language counts, when stage 2 read them — the drift check reuses. */
  projectLanguages: IdentifierLanguageCountRow[] | undefined;
}

/**
 * Stages 3-4: the evidence read in the answer's language namespace (bd
 * tea-rags-mcp-0qaht) — every later stage reads through `graphDb` — each row
 * classified in its OWN file language's casing.
 */
interface NamespacedNamingEvidence {
  namespace: readonly string[] | undefined;
  /** Whether `graphDb` was scoped after the language was decided (else it is the request's declared reader). */
  scopedLate: boolean;
  graphDb: IdentifierReader;
  /** The concept types actually read — the language's non-concept types leave `byType`. */
  types: string[];
  typeRows: (LexiconTypeRow & { casing: IdentifierCasing })[];
  calleeRows: LexiconCalleeRow[];
  casingFor: KindCasing;
  rowCasing: RowCasing;
  driftWarning: string | undefined;
}

/** Casing per declaration kind: a `return` row names a method. */
type KindCasing = (kind: IdentifierDeclarationKind) => IdentifierCasing;

/** Casing of one evidence row: its own file language's role casing. */
type RowCasing = (row: { kind: IdentifierDeclarationKind; language?: string | null }) => IdentifierCasing;

const KIND_ROLE: Record<IdentifierDeclarationKind, IdentifierRole> = {
  param: "param",
  local: "local",
  field: "field",
  return: "method",
};

export class NamingLexiconOps {
  constructor(private readonly deps: NamingLexiconOpsDeps) {}

  /**
   * `scope` is internal (not a request field): diff mode passes the changed
   * files as `excludePaths`, and every evidence read then skips them.
   */
  async getNamingLexicon(
    req: NamingLexiconRequest,
    scope: NamingLexiconEvidenceScope = {},
  ): Promise<NamingLexiconResult> {
    validateRequest(req);
    // One addressing rule (bd tea-rags-mcp-xi2r9): index reads address the base index, git
    // reads the tree the caller stands in.
    const workingTree = await resolveIndexedWorkingTree(this.deps.collectionRegistry, req, this.deps.indexExists);
    // Every read answer carries the marker (bd tea-rags-mcp-xi2r9, live probe P2-4), on
    // every return path — so it is attached here, around the whole answer. Measured beside it.
    const view = this.deps.workingTreeOverlay?.view(workingTree, req.project);
    const answer = await this.answerNamingLexicon(req, scope, workingTree);
    return view ? { ...answer, workingTree: (await view).marker } : answer;
  }

  private async answerNamingLexicon(
    req: NamingLexiconRequest,
    scope: NamingLexiconEvidenceScope,
    workingTree: WorkingTree,
  ): Promise<NamingLexiconResult> {
    const { collectionName } = workingTree.baseIndex;
    const workTree = workingTree.root || undefined;
    // Every sub-read — concept search, metrics — addresses the index resolved HERE, never
    // re-resolves the path: a worktree path hashes to a collection that does not exist (bd tea-rags-mcp-2kplu).
    const addressed = addressedRequest(req, collectionName, workTree);
    const indexLag =
      workTree === undefined ? undefined : readTreeLag(this.deps.collectionRegistry, collectionName, workTree);
    // Diff mode reads the change first: its files are the evidence every read excludes.
    const diff = isDiffRequest(req) ? await this.readDiff(req, workTree) : undefined;
    const excludePaths = [...(scope.excludePaths ?? []), ...(diff?.files ?? [])];
    const activePhysicalCollectionName = this.deps.resolveActiveCollection
      ? await this.deps
          .resolveActiveCollection(collectionName)
          .catch(() => resolvePhysicalCollection(collectionName, []))
      : resolvePhysicalCollection(collectionName, []);

    let handle: { graphDb: GraphDbClient };
    try {
      handle = await this.deps.pool.acquireReader(activePhysicalCollectionName);
    } catch (error) {
      return {
        scope: "",
        byType: [],
        names: [],
        notices: [`codegraph store unavailable: ${errorMessage(error)}`],
        ...(indexLag ? { indexLag } : {}),
      };
    }
    try {
      const reader = handle.graphDb;
      const context: AnswerContext = { alignment: {}, excludePaths, lookupCollisions: true };
      const lexicon = asksLexicon(addressed)
        ? await this.answer(reader, addressed, context)
        : { scope: "", byType: [], names: [] };
      const answer: NamingLexiconResult = { ...lexicon, ...(indexLag ? { indexLag } : {}) };
      if (diff === undefined) return answer;
      // A review's findings carry no evidence: its collisions are not looked up.
      const { review, notices } = await this.review(reader, addressed, diff, { ...context, lookupCollisions: false });
      const allNotices = unique([...(answer.notices ?? []), ...diff.notices, ...notices]);
      return { ...answer, ...(allNotices.length > 0 ? { notices: allNotices } : {}), review };
    } finally {
      await handle.graphDb.close().catch(() => undefined);
    }
  }

  /**
   * Diff mode's read, mapped onto the naming-specific half: per reviewed file
   * its added lines and — when something was added and a codegraph language
   * walks it — its declarations. A file the ontology calls non-production, one
   * no codegraph language walks, or an unreadable one is not judged; a listed
   * file with no diff was read whole by {@link readDiffScope}.
   */
  private async readDiff(req: NamingLexiconRequest, repoRoot: string | undefined): Promise<DiffRead> {
    const read = await readDiffScope(repoRoot, { base: req.changes?.base, files: req.files });
    // `repoRoot` is the tree the change is read from (`resolveWorkingTree`).
    const extract = this.deps.extractDeclarations?.forWorkingTree(read.workTree);
    const judged: DiffFile[] = [];
    const notJudged: NamingReviewNotJudgedEntry[] = [];
    for (const relPath of read.files) {
      const added = read.addedRanges.get(relPath) ?? [];
      if (added.length === 0) continue;
      const file = read.nonProduction.has(relPath)
        ? "nonProduction"
        : readDiffFile(extract, read.workTree, relPath, added);
      if (typeof file === "string") {
        notJudged.push({ relPath, kind: "file", reason: file });
        continue;
      }
      judged.push(file);
    }
    return {
      workTree: read.workTree,
      base: read.base,
      mergeBase: read.mergeBase,
      notices: [...read.notices],
      changedFiles: read.changedFiles,
      wholeFiles: read.wholeFiles,
      files: [...read.files],
      judged,
      notJudged,
      skipped: read.skipped,
    };
  }

  /**
   * Diff mode's judgement (spec §6.4–6.5): every added declaration becomes the
   * draft an agent would pass, judged by the same stages as `names[]` — one
   * answer per language, so each draft is cased in its own file's language.
   * Identical drafts of one directory are judged once and their verdict fanned
   * out to each declaration: a large diff does not multiply the per-type-draft
   * concept search.
   */
  private async review(
    reader: IdentifierReader,
    req: NamingLexiconRequest,
    diff: DiffRead,
    context: AnswerContext,
  ): Promise<{ review: NamingReviewResult; notices: string[] }> {
    const drafts = diff.judged.flatMap(reviewDrafts);
    const groups = new Map<string, { drafts: NamingLexiconDraftName[]; index: Map<string, number> }>();
    const slot: { language: string; at: number }[] = [];
    for (const d of drafts) {
      const group = groups.get(d.language) ?? { drafts: [], index: new Map<string, number>() };
      groups.set(d.language, group);
      const key = reviewDraftKey(d);
      let at = group.index.get(key);
      if (at === undefined) {
        at = group.drafts.push(d.draft) - 1;
        group.index.set(key, at);
      }
      slot.push({ language: d.language, at });
    }

    const notices: string[] = [];
    const verdicts = new Map<string, NamingLexiconNameVerdict[]>();
    for (const [language, group] of groups) {
      const answer = await this.answer(reader, { ...collectionRef(req), language, names: group.drafts }, context);
      verdicts.set(language, answer.names);
      notices.push(...(answer.notices ?? []));
    }

    const findings: NamingReviewFinding[] = [];
    const notes: NamingReviewNote[] = [];
    let conforming = 0;
    let novel = 0;
    drafts.forEach((d, i) => {
      const judged = verdicts.get(slot[i].language)?.[slot[i].at];
      if (judged === undefined) return;
      const { name: _name, evidence: _evidence, language: _language, genericName, ...verdict } = judged;
      if (verdict.verdict === "CONFORMS" && verdict.alternatives === undefined) {
        conforming++;
        // A generic name that conforms is information, not a finding (bd tea-rags-mcp-bjfa0).
        if (genericName !== undefined) {
          notes.push({
            relPath: d.relPath,
            line: d.line,
            name: d.draft.name,
            kind: d.kind,
            ...(d.type !== undefined ? { type: d.type } : {}),
            genericName,
          });
        }
        return;
      }
      if (genericName === undefined && isNovelVerdict(verdict)) {
        novel++;
        return;
      }
      findings.push({
        relPath: d.relPath,
        line: d.line,
        name: d.draft.name,
        kind: d.kind,
        ...(d.type !== undefined ? { type: d.type } : {}),
        ...verdict,
        ...(genericName !== undefined ? { genericName } : {}),
      });
    });
    findings.sort((a, b) => a.relPath.localeCompare(b.relPath) || a.line - b.line);
    notes.sort((a, b) => a.relPath.localeCompare(b.relPath) || a.line - b.line);

    return {
      review: {
        workTree: diff.workTree,
        base: diff.base,
        mergeBase: diff.mergeBase,
        changedFiles: diff.changedFiles,
        ...(diff.wholeFiles > 0 ? { wholeFiles: diff.wholeFiles } : {}),
        checked: drafts.length,
        conforming,
        novel,
        findings,
        ...(notes.length > 0 ? { notes } : {}),
        notJudged: diff.notJudged.filter((entry) => entry.kind === "file").length,
        ...notJudgedBreakdown(diff.notJudged),
        ...(diff.skipped > 0 ? { truncated: { cap: DIFF_FILE_CAP, skipped: diff.skipped } } : {}),
      },
      notices,
    };
  }

  private async answer(
    reader: IdentifierReader,
    req: NamingLexiconRequest,
    context: AnswerContext,
  ): Promise<NamingLexiconResult> {
    const { alignment, excludePaths } = context;
    // Every language: the drift check, and the type-name reads, which scope themselves per draft.
    const unscoped = scopedEvidence(reader, { excludePaths });
    // A language the request names scopes every read from the start; else the reads that decide it
    // (asked type rows, callee rows, language counts) run over every language.
    const declaredNamespace = this.typeNamespaceLanguages(req.language);
    const early =
      declaredNamespace === undefined
        ? unscoped
        : scopedEvidence(reader, { excludePaths, languages: declaredNamespace });
    const allDrafts = req.names ?? [];
    const drafts = allDrafts.filter((d): d is NamingLexiconValueDraft => !isTypeDraft(d));
    const typeDrafts = allDrafts.filter(isTypeDraft) as NamingLexiconTypeDraft[];
    const notices: string[] = [];

    // Stages 1-2 (see the pipeline above): the asked set, then the widened
    // scope and the language whose descriptor applies there.
    const asked = await this.readAskedTypes(early, req, drafts);
    const resolved = await this.resolveAnswerScope(early, req, typeDrafts, asked);

    // Stages 3-4: the evidence read in the answer's language namespace
    // (bd tea-rags-mcp-0qaht), each row classified in its own language's casing.
    const evidence = await this.readNamespacedEvidence(unscoped, early, reader, resolved, declaredNamespace, context);

    const byType = buildTypeEntries(evidence.types, evidence.typeRows, evidence.casingFor);
    const byCallee = resolved.draftCallees.map((callee) =>
      buildCalleeEntry(callee, evidence.calleeRows, evidence.casingFor),
    );
    const typeNameHeads = await this.typeNameHeads(unscoped, req, resolved.language);

    // Stage 5: the concept.
    const conceptTerms = await this.answerConceptTerms(req, notices);

    // Stage 6: names. A value draft that names its file is judged with that
    // file out of every read (bd tea-rags-mcp-xsxkr).
    const blind = drafts.filter((d) => d.path === undefined);
    const blindVerdicts = await this.judgeBlindValueDrafts(
      req,
      blind,
      resolved,
      evidence,
      conceptTerms,
      declaredNamespace,
      context,
    );
    const ownedVerdicts = await this.judgeOwnedValueDrafts(reader, req, drafts, resolved.language, context, notices);
    let blindAt = 0;
    const valueVerdicts = drafts.map((d) => ownedVerdicts.get(d) ?? blindVerdicts[blindAt++]);

    // Stage 7: type names — each draft reads its own path language's type namespace, so the reader binds none.
    const typeVerdicts =
      typeDrafts.length === 0
        ? []
        : await this.judgeTypeDrafts(unscoped, req, typeDrafts, resolved.language, notices, alignment);
    const names = inDraftOrder(allDrafts, valueVerdicts, typeVerdicts);

    return {
      scope: resolved.scope.prefix,
      ...(resolved.language ? { language: resolved.language } : {}),
      byType,
      ...(typeNameHeads ? { typeNameHeads } : {}),
      ...(resolved.draftCallees.length > 0 ? { byCallee } : {}),
      ...(conceptTerms ? { concept: { terms: conceptTerms } } : {}),
      names,
      ...(notices.length > 0 ? { notices } : {}),
      ...(evidence.driftWarning ? { driftWarning: evidence.driftWarning } : {}),
    };
  }

  /** Stage 1: the types asked ∪ anchors' param / return types ∪ drafts' types, and the drafts' callees. */
  private async readAskedTypes(
    early: IdentifierReader,
    req: NamingLexiconRequest,
    drafts: readonly NamingLexiconValueDraft[],
  ): Promise<AskedNamingSet> {
    const anchorTypes =
      req.anchors && req.anchors.length > 0
        ? (await early.anchorIdentifierTypes(req.anchors)).map((row) => row.typeName)
        : [];
    const askedTypes = unique([...(req.types ?? []), ...anchorTypes, ...drafts.flatMap((d) => d.type ?? [])]);
    const draftCallees = uniqueCallees(drafts.flatMap((d) => (d.callee && d.type === undefined ? [d.callee] : [])));
    return { askedTypes, draftCallees };
  }

  /**
   * Stage 2: the widened scope, then the language whose descriptor applies
   * there. A language decided only afterwards leaves the scope as resolved
   * over every language: it picks a path prefix, not evidence.
   */
  private async resolveAnswerScope(
    early: IdentifierReader,
    req: NamingLexiconRequest,
    typeDrafts: readonly NamingLexiconTypeDraft[],
    asked: AskedNamingSet,
  ): Promise<ResolvedNamingScope> {
    const declared = req.language ? this.deps.namingConventions.get(req.language) : undefined;
    const supportTypes = declared ? conceptTypes(asked.askedTypes, declared) : asked.askedTypes;
    const scope = await resolveScope(
      early,
      pathPatternLiteralPrefix(req.pathPattern),
      supportTypes,
      asked.draftCallees,
    );
    const pathPrefixes = scope.prefix === "" ? undefined : [scope.prefix];

    // byCallee's rows are read before the language is decided: they may decide it.
    const earlyCalleeRows =
      asked.draftCallees.length === 0
        ? []
        : (scope.calleeRows ??
          (await early.aggregateIdentifiersByCallee({
            callees: asked.draftCallees,
            pathPrefixes,
            groupByLanguage: true,
            countHolders: true,
          })));

    let { language } = req;
    let projectLanguages: IdentifierLanguageCountRow[] | undefined;
    // With no language and no pattern, the rows the request names decide it — read them first.
    let askedTypeRows: LexiconTypeRow[] | undefined;
    if (language === undefined && !req.pathPattern) {
      askedTypeRows = await readTypeRows(early, asked.askedTypes, pathPrefixes);
      language = dominantRowLanguage([...askedTypeRows, ...earlyCalleeRows]);
      // Type drafts name their files: with no value evidence, their languages decide (bd tea-rags-mcp-icuxg).
      language ??= dominantRowLanguage(typeDrafts.map((d) => ({ language: this.languageOfPath(d.path), n: 1 })));
    }
    if (language === undefined) {
      const decided = await requestedLanguageCounts(early, req.pathPattern);
      projectLanguages = decided.projectCounts;
      language = decided.counts.find((c) => c.language !== null)?.language ?? undefined;
    }
    const convention = language ? this.deps.namingConventions.get(language) : undefined;
    return {
      ...asked,
      scope,
      pathPrefixes,
      earlyCalleeRows,
      askedTypeRows,
      language,
      convention,
      nonConceptTypes: convention?.nonConceptTypes ?? [],
      projectLanguages,
    };
  }

  /**
   * Stages 3-4: from here on every evidence read stays within the answer's
   * language namespace (bd tea-rags-mcp-0qaht). byType (store aggregate +
   * name-inferred) over the concept types only — asked type rows read before
   * the language was decided are read again in its namespace: their
   * `name-inferred` rows weighed a name's typed owners across every language,
   * which no per-row filter can undo. Casing: the answer's language for
   * drafts, each row's own language for evidence.
   */
  private async readNamespacedEvidence(
    unscoped: IdentifierReader,
    early: IdentifierReader,
    reader: IdentifierReader,
    resolved: ResolvedNamingScope,
    declaredNamespace: readonly string[] | undefined,
    context: AnswerContext,
  ): Promise<NamespacedNamingEvidence> {
    const {
      language,
      convention,
      scope,
      askedTypes,
      askedTypeRows,
      earlyCalleeRows,
      nonConceptTypes,
      pathPrefixes,
      projectLanguages,
    } = resolved;
    const namespace = this.typeNamespaceLanguages(language);
    const scopedLate = namespace !== undefined && declaredNamespace === undefined;
    const graphDb = scopedLate
      ? scopedEvidence(reader, { excludePaths: context.excludePaths, languages: namespace })
      : early;
    // The callee rows were read split by file language with holders per group, so keeping the
    // namespace's groups is exactly the scoped read — a group of unknown language included, as the store keeps it.
    const storedCalleeRows = scopedLate
      ? earlyCalleeRows.filter((row) => typeof row.language !== "string" || namespace.includes(row.language))
      : earlyCalleeRows;

    // The table is stale when it is empty in EVERY language, not in the answer's.
    const driftWarning =
      scope.support === 0 && scope.prefix === "" && (await identifierTableIsStale(unscoped, projectLanguages))
        ? NAMING_LEXICON_DRIFT_WARNING
        : undefined;

    const types = askedTypes.filter((t) => !isNonConceptType(t, nonConceptTypes));
    const storedTypeRows =
      askedTypeRows !== undefined && !scopedLate && types.length === askedTypes.length
        ? askedTypeRows
        : await readTypeRows(graphDb, types, pathPrefixes);

    const observed = [...storedTypeRows, ...storedCalleeRows];
    const casingFor = kindCasing(convention, observed);
    const rowCasing = rowCasingResolver(this.deps.namingConventions, casingFor, kindCasing(undefined, observed));
    return {
      namespace,
      scopedLate,
      graphDb,
      types,
      typeRows: storedTypeRows.map((row) => ({ ...row, casing: rowCasing(row) })),
      calleeRows: storedCalleeRows.map((row) => ({ ...row, casing: rowCasing(row) })),
      casingFor,
      rowCasing,
      driftWarning,
    };
  }

  /**
   * Stage 5: the concept's terms — `undefined` when the request asks for none.
   * Any failure but an input error is one notice; the other stages still answer.
   */
  private async answerConceptTerms(req: NamingLexiconRequest, notices: string[]): Promise<ConceptTerm[] | undefined> {
    // validateRequest guarantees a language whenever a concept is set.
    if (!(req.concept && req.language)) return undefined;
    try {
      return await this.conceptTerms(req, req.concept, req.language);
    } catch (error) {
      if (error instanceof InputValidationError) throw error;
      notices.push(`concept step skipped: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * Stage 6, the drafts that name no file: judged by the whole evidence the
   * answer read, in its casing and its language namespace. The drafts that
   * name their file are judged apart ({@link NamingLexiconOps#judgeOwnedValueDrafts}).
   */
  private async judgeBlindValueDrafts(
    req: NamingLexiconRequest,
    blind: readonly NamingLexiconValueDraft[],
    resolved: ResolvedNamingScope,
    evidence: NamespacedNamingEvidence,
    conceptTerms: ConceptTerm[] | undefined,
    declaredNamespace: readonly string[] | undefined,
    context: AnswerContext,
  ): Promise<NamingLexiconNameVerdict[]> {
    if (blind.length === 0) return [];
    const { alignment, excludePaths } = context;
    const { typeRows, calleeRows, casingFor, rowCasing, namespace, scopedLate } = evidence;
    return judgeDrafts(evidence.graphDb, blind, {
      typeRows,
      calleeRows,
      casingFor,
      rowCasing,
      nonConceptTypes: resolved.nonConceptTypes,
      conceptTerms,
      pathPrefixes: resolved.pathPrefixes,
      ontologyLanguages: namespaceProfiles(this.deps.ontologyLanguages, namespace),
      methodHeadWords: {
        reads: (alignment.methodHeadWordRows ??= new Map<string, Promise<MethodHeadWordRow[]>>()),
        key: JSON.stringify([
          typeNamespaceKey(scopedLate ? namespace : declaredNamespace),
          resolved.pathPrefixes ?? [],
          excludePaths,
        ]),
      },
      collisionHolders: context.lookupCollisions
        ? async (name) => this.collisionHolders(req, name, excludePaths, namespace)
        : undefined,
    });
  }

  /**
   * The value drafts that name their file (`path`, bd tea-rags-mcp-xsxkr),
   * judged per file by the same stages with that file out of every evidence
   * read — the reader diff mode gives a changed file — so an existing
   * declaration neither counts itself in `evidence.n`, collides with itself,
   * nor lends its own row to the convention it is judged against. One answer
   * per file, in the answer's language.
   */
  private async judgeOwnedValueDrafts(
    reader: IdentifierReader,
    req: NamingLexiconRequest,
    drafts: readonly NamingLexiconValueDraft[],
    language: string | undefined,
    context: AnswerContext,
    notices: string[],
  ): Promise<Map<NamingLexiconValueDraft, NamingLexiconNameVerdict>> {
    const byPath = new Map<string, NamingLexiconValueDraft[]>();
    for (const draft of drafts) {
      if (draft.path !== undefined) byPath.set(draft.path, [...(byPath.get(draft.path) ?? []), draft]);
    }
    const verdicts = new Map<NamingLexiconValueDraft, NamingLexiconNameVerdict>();
    for (const [path, owned] of byPath) {
      const methods = owned.flatMap((d) => (d.kind === "return" ? [d.name] : []));
      const owner = methods.length > 0 ? await ownerTypeAt(reader, path, methods) : undefined;
      const names = owned.map(({ path: _path, ...draft }) =>
        draft.kind === "return" && owner !== undefined && draft.owner === undefined ? { ...draft, owner } : draft,
      );
      const scoped = { ...req, ...(language !== undefined ? { language } : {}), types: [], anchors: [], names };
      const answer = await this.answer(reader, scoped, { ...context, excludePaths: [...context.excludePaths, path] });
      owned.forEach((draft, i) => verdicts.set(draft, answer.names[i]));
      notices.push(...(answer.notices ?? []).filter((notice) => !notices.includes(notice)));
    }
    return verdicts;
  }

  /**
   * The symbols a colliding value / return draft collides with (bd
   * tea-rags-mcp-xsxkr): the indexed symbols whose short name IS the draft's,
   * outside the excluded files, at most {@link MAX_COLLISION_EXAMPLES}. Empty
   * without a symbol lookup or when it fails — the collision itself stands.
   * Within the answer's language namespace, as the collision flag is (bd
   * tea-rags-mcp-0qaht): a one-language namespace is the lookup's `language`
   * filter; a wider one keeps the hits whose path routes into it.
   */
  private async collisionHolders(
    req: NamingLexiconRequest,
    name: string,
    excludePaths: readonly string[],
    namespace: readonly string[] | undefined,
  ): Promise<string[]> {
    const { explore } = this.deps;
    if (explore.findSymbol === undefined) return [];
    const inNamespace = (relPath: string): boolean => {
      const pathLanguage = this.languageOfPath(relPath);
      return namespace === undefined || pathLanguage === undefined || namespace.includes(pathLanguage);
    };
    try {
      // A method call: the explore facade reads its own ops through `this`.
      const response = await explore.findSymbol({
        ...collectionRef(req),
        symbol: name,
        ...(namespace?.length === 1 ? { language: namespace[0] } : {}),
        metaOnly: true,
        fields: COLLISION_LOOKUP_FIELDS,
        limit: COLLISION_LOOKUP_LIMIT,
      });
      const ids = response.results.flatMap((r) => {
        const { symbolId, relativePath } = r.payload ?? {};
        if (typeof symbolId !== "string" || typeof relativePath !== "string") return [];
        return symbolShortName(symbolId) === name && !excludePaths.includes(relativePath) && inNamespace(relativePath)
          ? [symbolId]
          : [];
      });
      return unique(ids).slice(0, MAX_COLLISION_EXAMPLES);
    } catch {
      return [];
    }
  }

  /**
   * The type declarations each single-word `types` entry heads (bd
   * tea-rags-mcp-i569j), under the REQUESTED pattern's literal prefix — never
   * the widened value scope: the question is the suffix vocabulary of the place
   * asked about. Read in the answer's type namespace; `undefined` when no
   * single-word type is asked.
   */
  private async typeNameHeads(
    graphDb: IdentifierReader,
    req: NamingLexiconRequest,
    language: string | undefined,
  ): Promise<{ scope: string; heads: NamingLexiconTypeNameHead[] } | undefined> {
    const words = (req.types ?? []).filter((type) => typeNameWords(type).length === 1);
    if (words.length === 0) return undefined;
    const scope = pathPatternLiteralPrefix(req.pathPattern);
    const languages = this.typeNamespaceLanguages(language);
    const rows = await graphDb.readTypeNameRows({
      pathPrefixes: scope === "" ? [] : [scope],
      kinds: TYPE_DRAFT_KINDS,
      nonProductionPaths: ontologyNonProductionPaths(),
      ...(languages !== undefined ? { languages } : {}),
    });
    return { scope, heads: typeNameHeadCarriers(rows, words) };
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
    const domain = domainPattern(pathPatternLiteralPrefix(req.pathPattern));
    let holders = await search(domain);
    if (domain !== undefined && holders.length < MIN_CONCEPT_HOLDERS) holders = await search(undefined);
    return extractConceptTerms(holders);
  }

  /**
   * Stage 7: one read of the project's declarations, then per draft a concept
   * search and {@link judgeTypeDraft}. The first failed search is a notice and
   * stops further searches — for the whole request, through `alignment`; the
   * drafts are still judged, without alignment.
   */
  private async judgeTypeDrafts(
    graphDb: IdentifierReader,
    req: NamingLexiconRequest,
    drafts: readonly NamingLexiconTypeDraft[],
    language: string | undefined,
    notices: string[],
    alignment: TypeAlignmentState,
  ): Promise<NamingLexiconNameVerdict[]> {
    const evidenceByKey = new Map<string, TypeNameEvidence>();
    let tableEmpty = false;
    const failedBefore = alignment.failure !== undefined;
    const verdicts: NamingLexiconNameVerdict[] = [];
    // A barrel re-exporting the draft's file is the same declaration, not a clash (bd
    // tea-rags-mcp-89k7k.15); an unreadable file graph leaves every collision standing.
    const twins = await (alignment.reexportTwins ??= readReexportTwins(graphDb));
    for (const draft of drafts) {
      const population = typeDraftPopulation(draft);
      const draftLanguage = this.languageOfPath(draft.path) ?? language;
      // The draft's type namespace: its language and every language sharing it (bd tea-rags-mcp-icuxg).
      const namespace = this.typeNamespaceLanguages(draftLanguage);
      const rows = await this.typeNameRows(graphDb, namespace, alignment);
      // An empty namespace is not an empty table: the notice needs every language's read.
      if (rows.length === 0 && !tableEmpty) {
        const all = namespace === undefined ? rows : await this.typeNameRows(graphDb, undefined, alignment);
        tableEmpty = all.length === 0;
      }
      const key = typeEvidenceKey(namespace, population);
      const shared = evidenceByKey.get(key) ?? typeNameEvidence(rows, population);
      evidenceByKey.set(key, shared);
      // The draft's own declaration never votes for itself — nor counts in `evidence.n` (bd tea-rags-mcp-xsxkr).
      const evidence = typeDraftEvidence(shared, draft);
      let conceptNames: string[] = [];
      let byMeaning: MeaningAlignment = {};
      // The concept search first: only head candidates its code holds are embedded — on the
      // self-index that cut the batch from ~65 words per draft to a handful.
      try {
        if (rows.length > 0 && alignment.failure === undefined) {
          conceptNames = await this.conceptTypeNames(req, draft, draftLanguage, evidence.rows);
          byMeaning = await this.alignByMeaning(graphDb, req, draft, evidence, conceptNames, {
            language: draftLanguage,
            alignment,
            evidenceKey: key,
          });
        }
      } catch (error) {
        if (error instanceof InputValidationError) throw error;
        alignment.failure = errorMessage(error);
      }
      const verdict = judgeTypeDraft({
        name: draft.name,
        path: draft.path,
        ...(draft.extends !== undefined ? { extends: draft.extends } : {}),
        ...(draft.symbolKind !== undefined ? { symbolKind: draft.symbolKind } : {}),
        ...(draft.filePrimary !== undefined ? { filePrimary: draft.filePrimary } : {}),
        casing: this.typeCasing(draftLanguage, population),
        evidence,
        conceptNames,
        ...(twins !== undefined ? { reexportTwins: twins } : {}),
        ...byMeaning,
      });
      const judgedIn = draftLanguage !== undefined && draftLanguage !== language ? draftLanguage : undefined;
      verdicts.push(typeDraftVerdict(draft, verdict, evidence.rows, judgedIn));
    }
    if (tableEmpty) notices.push(NAMING_LEXICON_TYPE_DECLARATIONS_EMPTY);
    if (!failedBefore && alignment.failure !== undefined) {
      notices.push(`type-name alignment skipped: ${alignment.failure}`);
    }
    return verdicts;
  }

  /**
   * The type names of the code nearest the draft's meaning, one list entry per
   * hit and name: the namespace segments of each hit's symbolId that are a
   * declared short name of the draft's population. The query is the draft's
   * `concept`, the request's, else the draft's own words.
   */
  private async conceptTypeNames(
    req: NamingLexiconRequest,
    draft: NamingLexiconTypeDraft,
    language: string | undefined,
    population: readonly TypeNameRow[],
  ): Promise<string[]> {
    const response = await this.deps.explore.semanticSearch({
      ...collectionRef(req),
      query: draft.concept ?? req.concept ?? typeNameWords(draft.name).join(" "),
      ...(language ? { language } : {}),
      filter: { presets: "production" },
      rerank: CONCEPT_RERANK,
      limit: CONCEPT_SEARCH_LIMIT,
      metaOnly: true,
      fields: CONCEPT_FIELDS,
    });
    const known = new Set(population.map((row) => row.shortName));
    return response.results.flatMap((r) => {
      const symbolId = r.payload?.symbolId;
      if (typeof symbolId !== "string") return [];
      return [...new Set(hitOwnSegments(symbolId))].filter((segment) => known.has(segment));
    });
  }

  /**
   * The inputs of alignment by meaning for one draft (bd tea-rags-mcp-433d2):
   * the heads usage establishes, the project's similarity floor, and the
   * similarity of the embedded words. Empty without an embedding port, a word
   * to compare, or a population large enough to place a floor on.
   */
  private async alignByMeaning(
    graphDb: IdentifierReader,
    req: NamingLexiconRequest,
    draft: NamingLexiconTypeDraft,
    evidence: TypeNameEvidence,
    conceptNames: readonly string[],
    context: { language: string | undefined; alignment: TypeAlignmentState; evidenceKey: string },
  ): Promise<MeaningAlignment> {
    if (this.deps.embeddings === undefined) return {};
    const { alignment, evidenceKey } = context;
    const usageEstablishedHeads = await this.usageEstablishedHeads(
      graphDb,
      req,
      draft,
      evidence,
      conceptNames,
      context,
    );
    const words = typeDraftAlignmentWords(draft, evidence, conceptNames, usageEstablishedHeads);
    if (words.length === 0) return {};
    const nullSimilarities = await this.headNullSimilarities(evidence, evidenceKey, alignment);
    if (nullSimilarities === undefined) return {};
    const vectors = await this.embedHeadWords(words, alignment);
    return {
      wordSimilarity: (a, b) => headWordSimilarity(vectors, a, b),
      nullSimilarities,
      ...(usageEstablishedHeads.size > 0 ? { usageEstablishedHeads } : {}),
    };
  }

  /**
   * The draft's grounded candidate heads exactly ONE type carries whose file
   * is imported at least as much as the project's `popular` files — the
   * `codegraph.file.fanIn` label threshold `get_index_metrics` publishes for the
   * draft's language, the one the reranker labels by. None without the
   * project's path or that threshold.
   */
  private async usageEstablishedHeads(
    graphDb: IdentifierReader,
    req: NamingLexiconRequest,
    draft: NamingLexiconTypeDraft,
    evidence: TypeNameEvidence,
    conceptNames: readonly string[],
    context: { language: string | undefined; alignment: TypeAlignmentState },
  ): Promise<Set<string>> {
    const files = singleCarrierHeadFiles(draft, evidence, conceptNames);
    const admitted = new Set<string>();
    if (files.size === 0) return admitted;
    const popular = await this.popularFanIn(req, context);
    if (popular === undefined) return admitted;
    for (const [head, relPath] of files) {
      if ((await graphDb.getFanIn(relPath)) >= popular) admitted.add(head);
    }
    return admitted;
  }

  /** The `popular` band's lower bound of `codegraph.file.fanIn` in `language`, once per request. */
  private async popularFanIn(
    req: NamingLexiconRequest,
    context: { language: string | undefined; alignment: TypeAlignmentState },
  ): Promise<number | undefined> {
    const { language, alignment } = context;
    const { explore } = this.deps;
    const { path, collection } = req;
    if (explore.getIndexMetrics === undefined || path === undefined || language === undefined) return undefined;
    // A method call: the explore facade reads its own ops through `this`.
    alignment.metrics ??= explore.getIndexMetrics(path, collection);
    const metrics = await alignment.metrics;
    return metrics.signals[language]?.[FAN_IN_SIGNAL]?.source?.labelMap[POPULAR_FAN_IN_LABEL];
  }

  /**
   * The population's null distribution of head similarity: its own head pairs
   * ({@link nullSimilarityDistribution} over {@link nullHeadSample}), embedded
   * in ONE batch the first time a request needs it and kept for the request.
   * Each draft's floor is its quantile corrected for the draft's comparisons.
   * `undefined` when the population is too small to measure.
   */
  private async headNullSimilarities(
    evidence: TypeNameEvidence,
    evidenceKey: string,
    alignment: TypeAlignmentState,
  ): Promise<readonly number[] | undefined> {
    const nulls = (alignment.nullSimilarities ??= new Map<string, readonly number[] | null>());
    const known = nulls.get(evidenceKey);
    if (known !== undefined) return known ?? undefined;
    const sample = nullHeadSample(evidence.headCounts);
    const vectors = sample.length >= MIN_NULL_SAMPLE_HEADS ? await this.embedHeadWords(sample, alignment) : undefined;
    const distribution = vectors
      ? nullSimilarityDistribution(sample, (a, b) => headWordSimilarity(vectors, a, b))
      : undefined;
    nulls.set(evidenceKey, distribution ?? null);
    return distribution;
  }

  /** Embeds, in ONE batch, the texts of `words` this request has not embedded yet; the request's cache. */
  private async embedHeadWords(
    words: readonly string[],
    alignment: TypeAlignmentState,
  ): Promise<ReadonlyMap<string, number[]>> {
    const vectors = (alignment.vectors ??= new Map<string, number[]>());
    const missing = [...new Set(words.flatMap(headWordTexts))].filter((text) => !vectors.has(text));
    if (missing.length > 0 && this.deps.embeddings !== undefined) {
      const embedded = await this.deps.embeddings.embedBatch(missing);
      missing.forEach((text, i) => vectors.set(text, embedded[i].embedding));
    }
    return vectors;
  }

  /**
   * The languages whose type declarations a draft in `language` is judged
   * against (bd tea-rags-mcp-icuxg): the language and every language its
   * naming convention's `typeNamespace` names too; `undefined` (every
   * language) when the draft's language is unknown. The conventions are the
   * injected ones and the ontology profiles' — both are the capabilities'
   * `naming`, and either may be the only one that knows a language.
   */
  private typeNamespaceLanguages(language: string | undefined): string[] | undefined {
    if (language === undefined) return undefined;
    const conventions: [string, IdentifierNamingConvention][] = [
      ...this.deps.namingConventions,
      ...(this.deps.ontologyLanguages ?? []).map((p): [string, IdentifierNamingConvention] => [p.language, p.naming]),
    ];
    const namespace = conventions.find(([member]) => member === language)?.[1].typeNamespace;
    if (namespace === undefined) return [language];
    const members = conventions.filter(([, c]) => c.typeNamespace === namespace).map(([member]) => member);
    return unique([language, ...members]).sort();
  }

  /** The production type and constant declarations of `languages` (every language when absent), once per request. */
  private async typeNameRows(
    graphDb: IdentifierReader,
    languages: readonly string[] | undefined,
    alignment: TypeAlignmentState,
  ): Promise<TypeNameRow[]> {
    const reads = (alignment.typeNameRows ??= new Map<string, Promise<TypeNameRow[]>>());
    const key = typeNamespaceKey(languages);
    let read = reads.get(key);
    if (read === undefined) {
      read = graphDb.readTypeNameRows({
        pathPrefixes: [],
        kinds: TYPE_NAME_READ_KINDS,
        nonProductionPaths: ontologyNonProductionPaths(),
        ...(languages !== undefined ? { languages } : {}),
      });
      reads.set(key, read);
    }
    return read;
  }

  /** The language a path's extension routes to, from the ontology's language profiles. */
  private languageOfPath(relPath: string): string | undefined {
    const dot = relPath.lastIndexOf(".");
    if (dot < 0) return undefined;
    const extension = relPath.slice(dot).toLowerCase();
    return this.deps.ontologyLanguages?.find((profile) => profile.extensions.includes(extension))?.language;
  }

  /** The canonical casing of the draft's role (`type` / `constant`) in its language; Pascal / SCREAMING otherwise. */
  private typeCasing(language: string | undefined, population: TypeDraftPopulation): IdentifierCasing {
    const role: IdentifierRole = population === "constant" ? "constant" : "type";
    const convention = language ? this.deps.namingConventions.get(language) : undefined;
    return convention?.casing[role][0] ?? (population === "constant" ? "screamingSnake" : "pascal");
  }
}

/**
 * The segments of a concept hit's symbol id that NAME it: everything after its
 * last `::`, split at `#` / `.` (`TaxPreparation::Api#error_message` → `Api`,
 * `error_message`). The `::` segments before it are its namespace, which
 * locates the hit the way its directories do (bd tea-rags-mcp-i569j): on
 * taxdome every `TaxPreparation::*` hit made the declared module
 * `TaxPreparation` a concept type name, which grounded the directory word
 * `preparation` as an alternative for `helper` and `args`.
 */
function hitOwnSegments(symbolId: string): string[] {
  const namespaceEnd = symbolId.lastIndexOf("::");
  return (namespaceEnd < 0 ? symbolId : symbolId.slice(namespaceEnd + 2)).split(/#|\./);
}

/**
 * The texts one head word is embedded as, compared pairwise and averaged
 * (bd tea-rags-mcp-433d2): the bare word, and the word as a type declaration.
 * On the self-index measurement (jina-embeddings-v2-base-code) the average
 * ranked the draft's concept first for 4 of 6 reachable drafts, the bare word
 * alone for 3 of 6 — `class descriptor` is nearer `class doc` than
 * `descriptor` is to `doc`.
 */
function headWordTexts(word: string): [string, string] {
  return [word, `class ${word}`];
}

/** The mean cosine of two words over their {@link headWordTexts} encodings, pairwise. */
function headWordSimilarity(vectors: ReadonlyMap<string, number[]>, a: string, b: string): number {
  const textsA = headWordTexts(a);
  const textsB = headWordTexts(b);
  const sum = textsA.reduce(
    (total, text, i) => total + cosine(vectors.get(text) ?? [], vectors.get(textsB[i]) ?? []),
    0,
  );
  return sum / textsA.length;
}

// ── request ──────────────────────────────────────────────────────────────

/** The request asks the lexicon itself — types, anchors, drafts or a concept — not only a diff review. */
function asksLexicon(req: NamingLexiconRequest): boolean {
  return (
    (req.types?.length ?? 0) > 0 ||
    (req.anchors?.length ?? 0) > 0 ||
    (req.names?.length ?? 0) > 0 ||
    (req.concept ?? "").length > 0
  );
}

/** Diff mode: `changes`, or a non-empty `files`. */
function isDiffRequest(req: NamingLexiconRequest): boolean {
  return req.changes !== undefined || (req.files?.length ?? 0) > 0;
}

function validateRequest(req: NamingLexiconRequest): void {
  if (!asksLexicon(req) && !isDiffRequest(req)) {
    throw new MissingArgumentError(["types | anchors | concept | names | changes | files"]);
  }
  if (req.concept && !req.language) throw new InvalidParameterError("concept", "requires 'language'");
  const pathless = (req.names ?? []).findIndex((draft) => isTypeDraft(draft) && !draft.path);
  if (pathless >= 0) throw new InvalidParameterError(`names[${pathless}].path`, "required with kind 'type'");
}

/**
 * The request addressed by the index `resolveWorkingTree` resolved once for it
 * (bd tea-rags-mcp-2kplu): its collection explicit, its path the tree the
 * caller stands in, no project alias left to resolve again. A sub-read handed this ref
 * reads that index — never the one the path would hash to.
 */
function addressedRequest(
  req: NamingLexiconRequest,
  collectionName: string,
  repoRoot: string | undefined,
): NamingLexiconRequest {
  const { project: _project, path: _path, ...rest } = req;
  return { ...rest, collection: collectionName, ...(repoRoot !== undefined ? { path: repoRoot } : {}) };
}

function collectionRef(req: NamingLexiconRequest): Pick<SemanticSearchRequest, "collection" | "project" | "path"> {
  return {
    ...(req.collection !== undefined ? { collection: req.collection } : {}),
    ...(req.project !== undefined ? { project: req.project } : {}),
    ...(req.path !== undefined ? { path: req.path } : {}),
  };
}

// ── scope ────────────────────────────────────────────────────────────────

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
    const calleeRows = await graphDb.aggregateIdentifiersByCallee({
      callees,
      pathPrefixes,
      groupByLanguage: true,
      countHolders: true,
    });
    return { prefix, support: sum(calleeRows), calleeRows };
  }
  return { prefix, support: sum(await graphDb.identifierLanguageCounts({ pathPrefixes })) };
}

/**
 * The file extensions a path pattern pins in its last segment: `**\/*.rb` →
 * `[".rb"]`, `*.{ts,tsx}` → `[".ts", ".tsx"]`. A last segment that does not end
 * in a literal extension or a brace list of them pins none.
 */
function pinnedExtensions(pathPattern: string | undefined): string[] | undefined {
  if (!pathPattern) return undefined;
  const last = pathPattern.slice(pathPattern.lastIndexOf("/") + 1);
  const single = /\.([\w+-]+)$/.exec(last);
  if (single) return [`.${single[1]}`];
  const braced = /\.\{([\w+,-]+)\}$/.exec(last);
  const extensions = braced?.[1].split(",").filter(Boolean) ?? [];
  return extensions.length > 0 ? extensions.map((ext) => `.${ext}`) : undefined;
}

/**
 * The language counts the language decision reads when the request names none:
 * those of the REQUESTED pattern — its literal prefix, narrowed to the
 * extensions it pins — never those of the widened evidence scope. A callee with
 * no rows under `app/**\/*.rb` widens the evidence to the project, and the
 * project's dominant language says nothing about the Ruby the caller is writing.
 * Only when the requested pattern holds no rows: the pinned extensions
 * project-wide, then the whole project (`projectCounts`, reused by the drift check).
 */
async function requestedLanguageCounts(
  graphDb: IdentifierReader,
  pathPattern: string | undefined,
): Promise<{ counts: IdentifierLanguageCountRow[]; projectCounts?: IdentifierLanguageCountRow[] }> {
  const prefix = pathPatternLiteralPrefix(pathPattern);
  const pathSuffixes = pinnedExtensions(pathPattern);
  const requested: IdentifierLanguageCountQuery[] = [];
  if (prefix !== "") requested.push({ pathPrefixes: [prefix], ...(pathSuffixes ? { pathSuffixes } : {}) });
  if (pathSuffixes) requested.push({ pathSuffixes });
  for (const query of requested) {
    const counts = await graphDb.identifierLanguageCounts(query);
    if (counts.length > 0) return { counts };
  }
  const projectCounts = await graphDb.identifierLanguageCounts({});
  return { counts: projectCounts, projectCounts };
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
  const stored: LexiconTypeRow[] = (
    await graphDb.aggregateIdentifiersByType({
      types,
      pathPrefixes,
      groupByLanguage: true,
      groupByMultiplicity: true,
      countSameTypeSiblings: true,
      countHolders: true,
    })
  ).map((row: IdentifierTypeAggregateRow) => ({ ...row }));
  if (stored.length === 0) return stored;
  return [...stored, ...(await nameInferredRows(graphDb, stored, new Set(types), pathPrefixes))];
}

/**
 * The `name-inferred` stage: every name the type rows carry, read once in scope
 * with all its types; a name typed by ≥ 3 owners with one type holding ≥ 80% of
 * those owners lends that type to its untyped rows — when it is an asked type.
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
    groupByLanguage: true,
    countHolders: true,
  });
  // Typed evidence is counted in OWNERS (bd tea-rags-mcp-bjfa0): three `existing` locals of one method
  // typed TaxPreparation once lent that type to every untyped `existing` in the project.
  const typedByName = new Map<string, Map<string, number>>();
  for (const row of byName) {
    if (row.typeName === null) continue;
    const perType = typedByName.get(row.name) ?? new Map<string, number>();
    perType.set(row.typeName, (perType.get(row.typeName) ?? 0) + (row.holders ?? row.n));
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
      ...(row.holders !== undefined ? { holders: row.holders } : {}),
      exampleOwner: row.exampleOwner,
      ...(row.language !== undefined ? { language: row.language } : {}),
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
    // Own-key read: `constructor` is a type source and also Object.prototype's.
    for (const row of typeRows) {
      const seen = Object.hasOwn(evidence, row.typeSource) ? (evidence[row.typeSource] ?? 0) : 0;
      evidence[row.typeSource] = seen + row.n;
    }
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
  rows: readonly LexiconCalleeRow[],
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
  calleeRows: readonly LexiconCalleeRow[];
  casingFor: KindCasing;
  rowCasing: RowCasing;
  nonConceptTypes: readonly string[];
  conceptTerms?: ConceptTerm[];
  pathPrefixes: string[] | undefined;
  ontologyLanguages?: readonly OntologyLanguageProfile[];
  /** The symbols a colliding name collides with; absent → not looked up. */
  collisionHolders?: (name: string) => Promise<string[]>;
  /** The request's verb-vocabulary reads, keyed by the reader's evidence scope. */
  methodHeadWords?: MethodHeadWordMemo;
}

/**
 * The drafts' names `get_ontology_report` judges generic in the answer's scope:
 * the report's summary read narrowed to those names (bounded by the drafts, not
 * the project), judged by the same {@link judgeGenericNames} with the same bar
 * and per-file casing. Empty without the ontology's language profiles.
 */
async function genericDraftNames(
  graphDb: IdentifierReader,
  names: readonly string[],
  pathPrefixes: string[] | undefined,
  languages: readonly OntologyLanguageProfile[] | undefined,
): Promise<Map<string, JudgedGenericName>> {
  if (!languages || names.length === 0) return new Map();
  const summary = await graphDb.readOntologyReportSummary(
    ontologyReportQuery(languages, { ...(pathPrefixes ? { pathPrefixes } : {}), names }, [], 1),
  );
  const casing = ontologyRowCasing(languages);
  const judged = judgeGenericNames(
    summary.genericNames,
    (relPath, name) => casing(relPath, "local", name),
    GENERIC_NAME_BAR,
  );
  return new Map(judged.map((g) => [g.name, g]));
}

async function judgeDrafts(
  graphDb: IdentifierReader,
  drafts: readonly NamingLexiconValueDraft[],
  ctx: DraftJudgementContext,
): Promise<NamingLexiconNameVerdict[]> {
  const draftNames = unique(drafts.map((d) => d.name));
  const [homonyms, collisions, sample, generic] = await Promise.all([
    graphDb.identifierNameTypes(draftNames),
    graphDb.existingSymbolShortNames(draftNames),
    graphDb.sampleIdentifierShapes({
      pathPrefixes: ctx.pathPrefixes,
      limit: SHAPE_PRIOR_SAMPLE,
      groupByLanguage: true,
    }),
    genericDraftNames(graphDb, draftNames, ctx.pathPrefixes, ctx.ontologyLanguages),
  ]);
  const prior = projectShapePrior(sample, ctx.casingFor, ctx.rowCasing);
  const taken = new Set(collisions);
  const holders = new Map<string, string[]>();
  if (ctx.collisionHolders) {
    for (const name of draftNames) if (taken.has(name)) holders.set(name, await ctx.collisionHolders(name));
  }
  // Untyped methods are judged by the project's method vocabulary (spec 2026-09-28 naming coverage, §D4).
  const untypedMethods = drafts.filter(isUntypedMethodDraft);
  const untypedMethod =
    untypedMethods.length === 0
      ? undefined
      : await readUntypedMethodEvidence(
          graphDb,
          untypedMethods,
          { pathPrefixes: ctx.pathPrefixes, nonProductionPaths: ontologyNonProductionPaths() },
          taken,
          ctx.methodHeadWords,
        );
  const overridden = new Map<NamingLexiconValueDraft, string[]>();
  for (const draft of drafts) {
    if (draft.kind !== "return" || draft.owner === undefined) continue;
    const declarations = await inheritedDeclarations(graphDb, draft.owner, draft.name);
    if (declarations.length > 0) overridden.set(draft, declarations);
  }

  const judgedVerdicts = drafts.map((draft) => {
    const kind = draft.kind ?? "local";
    return judgeDraftName({
      name: draft.name,
      kind,
      typeName: draft.type,
      casing: ctx.casingFor(kind),
      nonConceptTypes: ctx.nonConceptTypes,
      callee: draft.callee,
      typeMultiplicity: draft.typeMultiplicity,
      byTypeRows:
        draft.type === undefined ? undefined : byTypeRowsFor(draft.type, draft.typeMultiplicity ?? "one", ctx.typeRows),
      byCalleeRows: draft.callee ? byCalleeRowsFor(draft.callee, ctx.calleeRows) : undefined,
      conceptTerms: ctx.conceptTerms,
      projectShapePrior: prior.shapes,
      projectReturnVerbs: prior.returnVerbs,
      nameRows: sum(homonyms.filter((r) => r.name === draft.name)),
      nameIsGeneric: generic.has(draft.name),
      ...((overridden.get(draft) ?? []).length > 0 ? { overrides: overridden.get(draft)?.[0] } : {}),
      ...(untypedMethod && isUntypedMethodDraft(draft) ? { untypedMethod: untypedMethod(draft.name) } : {}),
      ...(draft.fileLocal !== undefined ? { fileLocal: draft.fileLocal } : {}),
    });
  });
  const family = await typeFamilyRows(
    graphDb,
    drafts.flatMap((draft, i) =>
      judgedVerdicts[i].verdict === "NO_CONVENTION" && draft.type !== undefined ? [draft.type] : [],
    ),
    ctx.pathPrefixes,
  );

  return drafts.map((draft, i) => {
    const ancestorDeclarations = overridden.get(draft) ?? [];
    const nameRows = homonyms.filter((r) => r.name === draft.name);
    const verdict =
      draft.type === undefined ? judgedVerdicts[i] : withFamilyAnalogues(judgedVerdicts[i], family(draft.type));
    const example =
      (verdict.verdict === "MISFIT" ? verdict.holder : undefined) ??
      [...ctx.typeRows, ...ctx.calleeRows].find((r) => r.name === draft.name)?.exampleOwner;
    const genericName = generic.get(draft.name);
    // The ancestors' declarations lead: the symbols the draft actually collides with by design.
    const collided = unique([...ancestorDeclarations, ...(holders.get(draft.name) ?? [])]).slice(
      0,
      MAX_COLLISION_EXAMPLES,
    );
    return {
      name: draft.name,
      ...verdict,
      evidence: {
        n: sum(nameRows),
        ...(example !== undefined ? { example } : {}),
        boundTypes: new Set(nameRows.flatMap((r) => (r.typeName === null ? [] : [r.typeName]))).size,
        collision: taken.has(draft.name) || ancestorDeclarations.length > 0,
        ...(collided.length > 0 ? { collisions: collided } : {}),
      },
      ...(genericName ? { genericName: { typeCount: genericName.typeCount, n: genericName.n } } : {}),
    };
  });
}

/** The most relatives one NO_CONVENTION type is compared with: a wide sibling set is a vocabulary, not a family. */
const MAX_FAMILY_TYPES = 20;

/**
 * The value rows of each type's family ({@link typeFamilyMembers}) — what a
 * NO_CONVENTION draft of that type is offered by analogy (lexicon friction
 * F3). One type-declaration read and one aggregate over every family, and
 * neither when no draft needs them.
 */
async function typeFamilyRows(
  graphDb: IdentifierReader,
  types: readonly string[],
  pathPrefixes: string[] | undefined,
): Promise<(type: string) => NamingByTypeRow[]> {
  if (types.length === 0) return () => [];
  const declared = (
    await graphDb.readTypeNameRows({
      pathPrefixes: [],
      kinds: TYPE_DRAFT_KINDS,
      nonProductionPaths: ontologyNonProductionPaths(),
    })
  ).map((row) => row.shortName);
  const families = new Map(
    unique(types).map((type) => [type, typeFamilyMembers(type, declared).slice(0, MAX_FAMILY_TYPES)]),
  );
  const members = unique([...families.values()].flat());
  if (members.length === 0) return () => [];
  const rows = await graphDb.aggregateIdentifiersByType({ types: members, pathPrefixes, countHolders: true });
  return (type) => {
    const family = new Set(families.get(type) ?? []);
    return rows
      .filter((row) => family.has(row.typeName))
      .map((row) => ({
        kind: row.kind,
        name: row.name,
        n: row.n,
        exampleOwner: row.exampleOwner,
        ...(row.holders !== undefined ? { holders: row.holders } : {}),
      }));
  };
}

/**
 * The draft type's rows of the draft's multiplicity (bd tea-rags-mcp-4p3sb.26 —
 * a `T[]` draft against collections of T, a `T` draft against single values),
 * merged per (kind, name, casing) across type sources and the file languages of
 * the answer's language namespace — the only rows it read (bd tea-rags-mcp-0qaht).
 * A row written before migration 034 reads `one`, the honest reading of old data.
 */
function byTypeRowsFor(
  typeName: string,
  multiplicity: IdentifierTypeMultiplicity,
  rows: readonly LexiconTypeRow[],
): NamingByTypeRow[] {
  const merged = new Map<string, NamingByTypeRow>();
  for (const row of rows) {
    if (row.typeName !== typeName || (row.typeMultiplicity ?? "one") !== multiplicity) continue;
    const key = `${row.kind}\u0000${row.name}\u0000${row.casing ?? ""}`;
    const prev = merged.get(key);
    const siblings = prev ? mergedSameTypeSiblingN(prev, row) : row.sameTypeSiblingN;
    const holders = prev ? mergedHolders(prev, row) : row.holders;
    merged.set(key, {
      kind: row.kind,
      name: row.name,
      n: (prev?.n ?? 0) + row.n,
      exampleOwner: prev && prev.exampleOwner < row.exampleOwner ? prev.exampleOwner : row.exampleOwner,
      ...(row.casing !== undefined ? { casing: row.casing } : {}),
      ...(siblings !== undefined ? { sameTypeSiblingN: siblings } : {}),
      ...(holders !== undefined ? { holders } : {}),
    });
  }
  return [...merged.values()];
}

function byCalleeRowsFor(callee: IdentifierBoundCallee, rows: readonly LexiconCalleeRow[]): NamingByCalleeRow[] {
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
      ...(r.holders !== undefined ? { holders: r.holders } : {}),
      exampleOwner: r.exampleOwner,
      ...(r.typeName !== undefined ? { typeName: r.typeName } : {}),
      ...(r.casing !== undefined ? { casing: r.casing } : {}),
    }));
}

/**
 * The project prior over a bounded sample of the scope's evidence-carrying
 * rows: shape shares per kind (each row in its own file language's role
 * casing) and the verbs of its `VERB_TYPE` returns.
 */
function projectShapePrior(
  sample: Awaited<ReturnType<IdentifierReader["sampleIdentifierShapes"]>>,
  casingFor: KindCasing,
  rowCasing: RowCasing,
): {
  shapes: Partial<Record<IdentifierDeclarationKind, NamingShapeDistribution>>;
  returnVerbs: NamingReturnVerbShare[];
} {
  const shapes: Partial<Record<IdentifierDeclarationKind, NamingShapeDistribution>> = {};
  const rows = sample.map((r) => ({
    kind: r.kind,
    name: r.name,
    n: r.n,
    casing: rowCasing(r),
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

/**
 * The casing an evidence row is classified in: the role casing of its OWN file
 * language's descriptor — the mechanism `OntologyReportOps#casingFor` applies
 * per row. A language with no descriptor → `observedCasing` (the casing most
 * observed names are written in); a file with no language → `answerCasing`,
 * the answer's own.
 */
function rowCasingResolver(
  conventions: ReadonlyMap<string, IdentifierNamingConvention>,
  answerCasing: KindCasing,
  observedCasing: KindCasing,
): RowCasing {
  return ({ kind, language }) => {
    if (language === undefined || language === null) return answerCasing(kind);
    const convention = conventions.get(language);
    return convention ? (convention.casing[KIND_ROLE[kind]][0] ?? FALLBACK_CASING) : observedCasing(kind);
  };
}

/**
 * The ontology language profiles of the answer's language namespace (bd
 * tea-rags-mcp-0qaht): the generic-name judgement reads only its languages.
 * No namespace → every profile; a namespace no profile describes → none, and
 * no generic judgement is read.
 */
function namespaceProfiles(
  profiles: readonly OntologyLanguageProfile[] | undefined,
  namespace: readonly string[] | undefined,
): readonly OntologyLanguageProfile[] | undefined {
  if (profiles === undefined || namespace === undefined) return profiles;
  const inNamespace = profiles.filter((profile) => namespace.includes(profile.language));
  return inNamespace.length > 0 ? inNamespace : undefined;
}

/** The file language most evidence rows come from, weighted by `n`; ties → alphabetical. */
function dominantRowLanguage(rows: readonly { language?: string | null; n: number }[]): string | undefined {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.language) counts.set(row.language, (counts.get(row.language) ?? 0) + row.n);
  }
  let best: [string, number] | undefined;
  for (const entry of counts) {
    if (!best || entry[1] > best[1] || (entry[1] === best[1] && entry[0] < best[0])) best = entry;
  }
  return best?.[0];
}

// ── type names ───────────────────────────────────────────────────────────

/**
 * A type draft's verdict with its evidence: `n` = the population's
 * declarations already carrying the short name, `example` = the colliding
 * declaration or the role's first example, `collision` = a COLLISION verdict.
 */
function typeDraftVerdict(
  draft: NamingLexiconTypeDraft,
  verdict: NamingVerdict,
  population: readonly TypeNameRow[],
  judgedIn: string | undefined,
): NamingLexiconNameVerdict {
  const shortName = typeNameLastSegment(draft.name);
  const example =
    verdict.verdict === "COLLISION"
      ? verdict.existing.symbolId
      : verdict.verdict === "MISFIT"
        ? verdict.role?.examples[0]
        : undefined;
  return {
    name: draft.name,
    ...(judgedIn !== undefined ? { language: judgedIn } : {}),
    ...verdict,
    evidence: {
      n: population.filter((row) => row.shortName === shortName).length,
      ...(example !== undefined ? { example } : {}),
      boundTypes: 0,
      collision: verdict.verdict === "COLLISION",
    },
  };
}

/**
 * The file pairs a re-export joins ({@link reexportTwins}), read once per
 * request. A failed read resolves `undefined` — no suppression, every
 * collision stands (bd tea-rags-mcp-89k7k.15), like {@link NamingLexiconOps#collisionHolders}'s.
 */
async function readReexportTwins(graphDb: IdentifierReader): Promise<ReexportTwins | undefined> {
  try {
    return reexportTwins((await graphDb.readFileDependencyGraph()).edges);
  } catch {
    return undefined;
  }
}

/** A type namespace's read key: its languages, `*` for every language. */
function typeNamespaceKey(languages: readonly string[] | undefined): string {
  return languages === undefined ? "*" : languages.join(",");
}

/** The evidence of one population in one type namespace. */
function typeEvidenceKey(languages: readonly string[] | undefined, population: TypeDraftPopulation): string {
  return `${typeNamespaceKey(languages)}\u0000${population}`;
}

/** The value and type verdicts back in the order the drafts were asked. */
function inDraftOrder(
  drafts: readonly NamingLexiconDraftName[],
  valueVerdicts: readonly NamingLexiconNameVerdict[],
  typeVerdicts: readonly NamingLexiconNameVerdict[],
): NamingLexiconNameVerdict[] {
  let value = 0;
  let type = 0;
  return drafts.map((draft) => (isTypeDraft(draft) ? typeVerdicts[type++] : valueVerdicts[value++]));
}

// ── diff mode ────────────────────────────────────────────────────────────

/**
 * One changed file with its text and declarations, or why it is not judged —
 * no extractor or no codegraph language for the path, or the file is
 * unreadable or unparsable.
 */
function readDiffFile(
  extract: NamingReviewFileExtractor | undefined,
  repoRoot: string,
  relPath: string,
  ranges: readonly AddedLineRange[],
): DiffFile | "noCodegraphLanguage" | "unreadable" {
  if (!extract) return "noCodegraphLanguage";
  try {
    const text = readFileSync(join(repoRoot, relPath), "utf8");
    const declarations = extract(relPath, text);
    return declarations === null ? "noCodegraphLanguage" : { relPath, ranges, text, declarations };
  } catch {
    return "unreadable";
  }
}

/**
 * The methods / functions on a file's added lines that no `return` row
 * carries — their return type is unknown (bd tea-rags-mcp-y33ee). Each becomes
 * an untyped `return` draft, judged by the method vocabulary (spec 2026-09-28
 * naming coverage, §D4); one per declaration, however many symbols it carries.
 * A name its declaration line does not spell is one a macro composed
 * (`has_one :account` → `build_account`), not one the author wrote: no draft,
 * and not counted as not judged either.
 */
function untypedCallables(file: DiffFile): DiffFile["declarations"]["callables"] {
  const { ranges, declarations } = file;
  const returned = new Set(declarations.values.filter((row) => row.kind === "return").map((row) => row.ownerSymbolId));
  return declarations.callables.filter(
    (callable) =>
      callable.spelledOnLine && inRanges(callable.line, ranges) && !callable.symbolIds.some((id) => returned.has(id)),
  );
}

/** `notJudgedBy` counts and the first {@link NOT_JUDGED_NAME_CAP} entries in path / line order; `{}` when none. */
function notJudgedBreakdown(
  entries: readonly NamingReviewNotJudgedEntry[],
): Pick<NamingReviewResult, "notJudgedBy" | "notJudgedNames"> {
  if (entries.length === 0) return {};
  const by: NonNullable<NamingReviewResult["notJudgedBy"]> = {};
  for (const { kind, reason } of entries) {
    const reasons = (by[kind] ??= {});
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  const names = [...entries]
    .sort((a, b) => a.relPath.localeCompare(b.relPath) || (a.line ?? 0) - (b.line ?? 0))
    .slice(0, NOT_JUDGED_NAME_CAP);
  return { notJudgedBy: by, notJudgedNames: names };
}

/**
 * A verdict with nothing to act on: NEW_TERM with no top terms and no
 * alternatives — the project has nothing to compare the name with. Diff mode
 * counts it (`novel`) instead of listing it.
 */
function isNovelVerdict(verdict: NamingVerdict): boolean {
  // A value no convention binds is a free choice: nothing to act on, like a bare NEW_TERM (lexicon friction F3).
  if (verdict.verdict === "NO_CONVENTION") return true;
  return verdict.verdict === "NEW_TERM" && verdict.topTerms.length === 0 && (verdict.alternatives?.length ?? 0) === 0;
}

/**
 * The code of the innermost chunk enclosing `line`, its first
 * {@link DIFF_CONCEPT_CODE_CHARS} characters; `""` when no chunk encloses it.
 */
function enclosingChunkCode(file: DiffFile, line: number): string {
  let enclosing: { startLine: number; endLine: number } | undefined;
  for (const chunk of file.declarations.chunks) {
    if (line < chunk.startLine || line > chunk.endLine) continue;
    if (!enclosing || chunk.endLine - chunk.startLine < enclosing.endLine - enclosing.startLine) enclosing = chunk;
  }
  if (!enclosing) return "";
  return file.text
    .split("\n")
    .slice(enclosing.startLine - 1, enclosing.endLine)
    .join("\n")
    .slice(0, DIFF_CONCEPT_CODE_CHARS);
}

function inRanges(line: number, ranges: readonly AddedLineRange[]): boolean {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

/**
 * The drafts of one file's ADDED declarations (spec §6.2–6.3): each value row
 * as `{ name, kind, type, typeMultiplicity, callee }`, each own type or
 * constant declaration (a re-opening declares nothing) as a `kind: "type"`
 * draft with its first supertype as `extends`.
 */
function reviewDrafts(file: DiffFile): ReviewDraft[] {
  const { relPath, ranges, declarations } = file;
  const { language } = declarations;
  const drafts: ReviewDraft[] = [];
  for (const row of declarations.values) {
    if (!inRanges(row.line, ranges)) continue;
    const owner = row.kind === "return" ? memberOwner(row.ownerSymbolId) : undefined;
    const draft: NamingLexiconValueDraft = {
      name: row.name,
      kind: row.kind,
      ...(row.typeName !== undefined ? { type: row.typeName } : {}),
      ...(row.typeMultiplicity !== undefined ? { typeMultiplicity: row.typeMultiplicity } : {}),
      ...(owner !== undefined ? { owner } : {}),
      ...(row.boundMember !== undefined
        ? {
            callee: {
              member: row.boundMember,
              ...(row.boundReceiver !== undefined ? { receiver: row.boundReceiver } : {}),
            },
          }
        : {}),
      ...fileLocalBindings(file, row),
    };
    drafts.push({
      relPath,
      line: row.line,
      language,
      kind: row.kind,
      ...(row.typeName !== undefined ? { type: row.typeName } : {}),
      draft,
    });
  }
  for (const callable of untypedCallables(file)) {
    const owner = callable.symbolIds.map(memberOwner).find((id) => id !== undefined);
    drafts.push({
      relPath,
      line: callable.line,
      language,
      kind: "return",
      draft: { name: callable.name, kind: "return", ...(owner !== undefined ? { owner } : {}) },
    });
  }
  // The changed file is out of the evidence: only the review sees which declaration is its primary (friction F4).
  const declared = declarations.types
    .filter((fact) => !fact.reopens)
    .toSorted((a, b) => a.line - b.line)
    .map((fact) => ({ fact, shortName: typeNameLastSegment(fact.typeId), relPath, symbolKind: fact.symbolKind }));
  const primary = filePrimaryDeclaration(declared)?.fact;
  for (const fact of declarations.types) {
    if (fact.reopens || !inRanges(fact.line, ranges)) continue;
    const ancestor = fact.conforms?.[0];
    const name = typeNameLastSegment(fact.typeId);
    const code = enclosingChunkCode(file, fact.line);
    const words = typeNameWords(name).join(" ");
    drafts.push({
      relPath,
      line: fact.line,
      language,
      kind: fact.symbolKind,
      draft: {
        name,
        kind: "type",
        path: relPath,
        symbolKind: fact.symbolKind,
        filePrimary: primary === undefined || primary === fact,
        ...(ancestor !== undefined ? { extends: ancestor } : {}),
        // Spec §4.1: in diff mode the concept query also carries the declaration's enclosing code.
        concept: code === "" ? words : `${words}\n${code}`,
      },
    });
  }
  return drafts;
}

/**
 * Drafts sharing this key get one verdict: same draft (name, kind, type, callee,
 * ancestor, symbol kind) in the same directory — what a verdict reads is the
 * draft and its directory, never its file (the changed files are excluded).
 * The concept (the enclosing code) is left out: identical declarations in one
 * directory share the first one's alignment search.
 */
function reviewDraftKey(d: ReviewDraft): string {
  const { path: _path, concept: _concept, ...draft } = d.draft;
  return `${directoryOf(d.relPath)}\u0000${JSON.stringify(draft)}`;
}

/**
 * The declaring file's precedent for one added value row (bd
 * tea-rags-mcp-hzrxn): its PRE-EXISTING bindings of the same role — same kind,
 * same type and multiplicity, the added lines excluded — counted per name. Read
 * off the working-tree extraction, never the index: the change's own file is
 * excluded from every project read, so only this extraction knows what its
 * settled names are. Empty for an untyped row (the role is the type's) and for
 * a row nothing pre-existing binds.
 */
function fileLocalBindings(file: DiffFile, row: IdentifierRow): { fileLocal?: FileLocalBindings } {
  if (row.typeName === undefined) return {};
  const multiplicity = row.typeMultiplicity ?? "one";
  const perName = new Map<string, number>();
  for (const prior of file.declarations.values) {
    if (inRanges(prior.line, file.ranges)) continue;
    if (prior.kind !== row.kind || prior.typeName !== row.typeName) continue;
    if ((prior.typeMultiplicity ?? "one") !== multiplicity) continue;
    perName.set(prior.name, (perName.get(prior.name) ?? 0) + 1);
  }
  if (perName.size === 0) return {};
  return {
    fileLocal: {
      file: file.relPath,
      bindings: [...perName]
        .map(([name, n]) => ({ name, n }))
        .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)),
    },
  };
}

function directoryOf(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  return slash < 0 ? "" : relPath.slice(0, slash);
}

// ── overrides ────────────────────────────────────────────────────────────

/** How far up an owner's ancestry an override is looked for — deeper hierarchies are not project code. */
const MAX_ANCESTOR_DEPTH = 10;

/** Kind order of one class's direct ancestors, nearest first — Ruby's prepend, include, superclass. */
const ANCESTOR_KIND_RANK: Record<string, number> = { prepend: 0, include: 1 };

/** The type a member symbol is declared in: `A::B#m` / `A::B.m` → `A::B`; a top-level function → none. */
function memberOwner(symbolId: string): string | undefined {
  const at = Math.max(symbolId.lastIndexOf("#"), symbolId.lastIndexOf("."));
  return at > 0 ? symbolId.slice(0, at) : undefined;
}

/**
 * The in-project declarations of method `name` in `owner`'s ancestry (bd
 * tea-rags-mcp-bjfa0), nearest ancestor first: breadth-first over the
 * persisted inheritance edges, each level in its declaration order (prepends,
 * then includes last-declared first, then the superclass), cycle-guarded and
 * capped at {@link MAX_ANCESTOR_DEPTH}. An ancestor counts when the symbol
 * table holds its instance or class method of that name. `owner` itself is
 * never read — its own declaration is the draft.
 */
async function inheritedDeclarations(graphDb: IdentifierReader, owner: string, name: string): Promise<string[]> {
  const seen = new Set<string>([owner]);
  const order: string[] = [];
  let level = [owner];
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const type of level) {
      const edges = await graphDb.getSupertypes(type);
      const ranked = [...edges].sort(
        (a, b) =>
          (ANCESTOR_KIND_RANK[a.kind] ?? 2) - (ANCESTOR_KIND_RANK[b.kind] ?? 2) ||
          (a.kind === "include" ? (b.ordinal ?? 0) - (a.ordinal ?? 0) : (a.ordinal ?? 0) - (b.ordinal ?? 0)),
      );
      for (const edge of ranked) {
        const ancestor = edge.ancestorSymbolId ?? edge.ancestorFqName;
        if (seen.has(ancestor)) continue;
        seen.add(ancestor);
        next.push(ancestor);
      }
    }
    order.push(...next);
    level = next;
  }
  if (order.length === 0) return [];
  const candidates = order.flatMap((type) => [`${type}#${name}`, `${type}.${name}`]);
  const declared = new Set((await graphDb.getSymbolVisibilities(candidates)).map((row) => row.symbolId));
  return candidates.filter((id) => declared.has(id));
}

/**
 * The type the `return` drafts at `path` are declared in (names mode, bd
 * tea-rags-mcp-bjfa0): of the types the file declares, the one that already
 * holds one of the methods, else the file's only type. Several types and no
 * method among them → unknown, and no draft is judged as an override.
 */
async function ownerTypeAt(
  reader: IdentifierReader,
  path: string,
  methods: readonly string[],
): Promise<string | undefined> {
  const declared = (
    await reader.readTypeNameRows({
      pathPrefixes: [path],
      kinds: ["class", "module"],
      nonProductionPaths: { caseInsensitive: [], caseSensitive: [] },
    })
  ).filter((row) => row.relPath === path);
  const types = unique(declared.map((row) => row.symbolId));
  if (types.length === 0) return undefined;
  const candidates = types.flatMap((type) => methods.flatMap((m) => [`${type}#${m}`, `${type}.${m}`]));
  const held = (await reader.getSymbolVisibilities(candidates)).find((row) => row.relPath === path);
  const holder = held === undefined ? undefined : memberOwner(held.symbolId);
  return holder ?? (types.length === 1 ? types[0] : undefined);
}

// ── evidence scope ───────────────────────────────────────────────────────

/** What {@link scopedEvidence} binds into every evidence read. */
interface EvidenceReadScope {
  /** Files never read (spec §6.4): diff mode's changed files, a value draft's own `path`. */
  excludePaths?: readonly string[];
  /** The answer's language namespace (bd tea-rags-mcp-0qaht); absent = every language. */
  languages?: readonly string[];
}

/**
 * The reader with the answer's evidence scope — `excludePaths` and its language
 * namespace — bound into every evidence read: one wrapper, so no stage can read
 * the changed files, or another language's rows, by forgetting to pass them.
 * `readTypeNameRows` and the method-name reads keep a caller's explicit
 * `languages` (a type draft reads its own path's namespace). `anchorIdentifierTypes` (the caller's own anchors)
 * and `hasData` read no evidence and pass through; so does the ontology summary's
 * language scope, which its query's language profiles carry. Nothing to bind →
 * the reader itself.
 */
function scopedEvidence(reader: IdentifierReader, scope: EvidenceReadScope): IdentifierReader {
  const excludePaths = scope.excludePaths === undefined ? [] : [...scope.excludePaths];
  const languages = scope.languages === undefined ? undefined : [...scope.languages];
  if (excludePaths.length === 0 && languages === undefined) return reader;
  const excluded = excludePaths.length > 0 ? { excludePaths } : {};
  const bound = { ...excluded, ...(languages ? { languages } : {}) };
  const languagesOf = (explicit: readonly string[] | undefined) => {
    const scoped = explicit ?? languages;
    return scoped ? { languages: scoped } : {};
  };
  return {
    aggregateIdentifiersByType: async (q) => reader.aggregateIdentifiersByType({ ...q, ...bound }),
    aggregateIdentifiersByCallee: async (q) => reader.aggregateIdentifiersByCallee({ ...q, ...bound }),
    aggregateIdentifiersByName: async (q) => reader.aggregateIdentifiersByName({ ...q, ...bound }),
    anchorIdentifierTypes: async (symbolIds) => reader.anchorIdentifierTypes(symbolIds),
    identifierNameTypes: async (names) =>
      languages === undefined
        ? reader.identifierNameTypes(names, excludePaths)
        : reader.identifierNameTypes(names, excludePaths, languages),
    existingSymbolShortNames: async (names) =>
      languages === undefined
        ? reader.existingSymbolShortNames(names, excludePaths)
        : reader.existingSymbolShortNames(names, excludePaths, languages),
    // The caller's explicit `languages` wins, as in `readTypeNameRows`.
    readMethodHeadWords: async (q) => reader.readMethodHeadWords({ ...q, ...excluded, ...languagesOf(q.languages) }),
    readMethodTailVerbs: async (q) => reader.readMethodTailVerbs({ ...q, ...excluded, ...languagesOf(q.languages) }),
    readMethodNamesMatching: async (q) =>
      reader.readMethodNamesMatching({ ...q, ...excluded, ...languagesOf(q.languages) }),
    countIdentifiers: async (q) => reader.countIdentifiers({ ...q, ...bound }),
    identifierLanguageCounts: async (q) => reader.identifierLanguageCounts({ ...q, ...bound }),
    sampleIdentifierShapes: async (q) => reader.sampleIdentifierShapes({ ...q, ...bound }),
    hasData: async () => reader.hasData(),
    readOntologyReportSummary: async (q) => reader.readOntologyReportSummary({ ...q, ...excluded }),
    readTypeNameRows: async (q) => {
      const typeLanguages = q.languages ?? languages;
      return reader.readTypeNameRows({ ...q, ...excluded, ...(typeLanguages ? { languages: typeLanguages } : {}) });
    },
    // A fan-in counts edges INTO an unchanged file; nothing of the diff to exclude.
    getFanIn: async (relPath) => reader.getFanIn(relPath),
    // The re-export joins are file-graph edges; the evidence scope binds nothing.
    readFileDependencyGraph: async () => reader.readFileDependencyGraph(),
    // An override is judged against its ANCESTORS' declarations, never the changed file's own.
    getSupertypes: async (fqName) => reader.getSupertypes(fqName),
    getSymbolVisibilities: async (symbolIds) => reader.getSymbolVisibilities(symbolIds),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** A symbol id's own name: its last `::` / `#` / `.` segment (`APolicy#same_firm?` → `same_firm?`). */
function symbolShortName(symbolId: string): string {
  return symbolId.split(/::|#|\./).at(-1) ?? symbolId;
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
