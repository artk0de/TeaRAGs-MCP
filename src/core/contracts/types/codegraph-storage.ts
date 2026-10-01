/**
 * Codegraph storage contracts — the driver-agnostic persistence surface.
 * `GraphDbClient` is the whole of it: node / edge / symbol writes (single and
 * batched), the metric and hierarchy reads, cycle and PageRank persistence, and
 * the run-stats surface. `BulkFileUpsertEntry` / `BulkSymbolUpsertEntry` are
 * the batched call shapes; `SymbolChunkResolver` is the narrow read seam
 * `domains/explore` depends on so it never has to see the client itself.
 *
 * The top layer of the codegraph contract set — it names types from every file
 * below it and nothing names it back. Re-exported verbatim by the
 * `codegraph.ts` barrel.
 */

import type {
  IdentifierBoundCallee,
  IdentifierDeclarationKind,
  IdentifierTypeMultiplicity,
  IdentifierTypeSource,
  PersistedIdentifierTypeSource,
} from "./codegraph-extraction.js";
import type {
  AmbiguousCallerSite,
  CalleeEdge,
  CallerEdge,
  ChunkGraphSignals,
  CycleEntry,
  CycleScope,
  EdgeKindCount,
  FileDependencyGraph,
  FileGraphMetrics,
  FileImportLookup,
  FileResolveStatsWrite,
  GraphEdges,
  GraphFileNode,
  NonPublicMemberEdge,
  PersistedHierarchyDescendantDependency,
  ResolveRunStatsRow,
} from "./codegraph-graph.js";
import type { HierarchySnapshot, InheritanceEdge } from "./codegraph-hierarchy.js";
import type { CodegraphPass1FileAggregates } from "./codegraph-pass1.js";
import type {
  FileScopedSymbolId,
  FileScopedSymbolRef,
  RelPath,
  SymbolDefinition,
  SymbolDefinitionKind,
  SymbolId,
  SymbolVisibilityRow,
} from "./codegraph-symbols.js";
import type {
  TemporalCochangeBuildMeta,
  TemporalCochangeGraph,
  TemporalCochangeSnapshot,
  TemporalSymbolCommitFileSnapshot,
} from "./codegraph-temporal.js";
import type { CaseSplitPathPatterns } from "./file-classification.js";

/**
 * Which `cg_pass1_aggregates` rows `GraphDbClient.listPass1Aggregates` returns.
 * `languages` narrows the read in SQL, before any slice's JSON is parsed; an
 * empty list reads nothing. `allLanguages` is for the caller that cannot know
 * the walked languages yet (the main thread of an unrestricted run) — the
 * barrier still keeps only its own families.
 */
export type Pass1AggregateReadScope =
  | { readonly kind: "languages"; readonly languages: readonly string[] }
  | { readonly kind: "allLanguages" };

/**
 * One file's worth of symbol definitions, as consumed by
 * `GraphDbClient.upsertSymbolsBulk` — the batched form of
 * `upsertSymbols(relPath, definitions)` that folds many files' worth of
 * reconciliation into a single transaction.
 */
export interface BulkSymbolUpsertEntry {
  relPath: RelPath;
  definitions: SymbolDefinition[];
}

/**
 * One file's worth of node + outgoing edges, as consumed by
 * `GraphDbClient.upsertFilesBulk` — the batched form of `upsertFile(node, edges)`
 * that folds many files' per-source-file DELETE+INSERT into a single transaction.
 */
export interface BulkFileUpsertEntry {
  node: GraphFileNode;
  edges: GraphEdges;
}

/**
 * One file's symbol → covering-chunk join, as consumed by
 * `GraphDbClient.updateSymbolChunkIdsBulk` — the batched form of
 * `updateSymbolChunkIds(relPath, chunkIds)` that folds a whole deferred chunk
 * pass into a single transaction (and, on the daemon path, a single round-trip).
 */
export interface SymbolChunkIdJoinEntry {
  relPath: RelPath;
  chunkIds: ReadonlyMap<SymbolId, string>;
}

/**
 * One `cg_identifiers` row (bd tea-rags-mcp-4p3sb.8): a declared identifier of
 * `ownerSymbolId`, with its best-known type and — for a local or field bound to
 * a call — that call's callee and its `CallRef.callText`
 * (`boundCallExpression`, the edge table's join key). Built at sink time from a
 * file's `FileExtraction`; the file is implied by the entry carrying it.
 */
export interface IdentifierRow {
  ownerSymbolId: SymbolId;
  kind: IdentifierDeclarationKind;
  name: string;
  line: number;
  typeName?: string;
  typeSource?: PersistedIdentifierTypeSource;
  /** Persisted as `type_multiplicity`; absent is written as `one` (bd tea-rags-mcp-4p3sb.26). */
  typeMultiplicity?: IdentifierTypeMultiplicity;
  boundMember?: string;
  boundReceiver?: string;
  boundCallExpression?: string;
  /**
   * Persisted as `bound_call_unwrapped` (migration 036, bd tea-rags-mcp-bjzaf):
   * whether the bound call's wrapper was consumed (`?`, `await`). Written for
   * every row with a `boundMember` — absent reads as `false` there — and NULL
   * on every other row.
   */
  boundCallUnwrapped?: boolean;
  /** Persisted as `return_wrapper` (migration 036): a `return` row's wrapper head, `IdentifierDeclaration.returnWrapper`. */
  returnWrapper?: string;
}

/** One file's identifier rows, as consumed by `GraphDbClient.replaceIdentifiersBulk`. */
export interface IdentifierReplaceEntry {
  relPath: RelPath;
  rows: readonly IdentifierRow[];
}

/**
 * One `cg_type_declarations` row (migration 038, bd tea-rags-mcp-vi0wx): a
 * `TypeDeclarationFact` as the naming lexicon persists it. Built at sink time
 * from a file's `FileExtraction`; the file is implied by the entry carrying it.
 */
export interface TypeDeclarationRow {
  /** The file's language — the column a per-language role read groups by. */
  language: string;
  typeId: string;
  /** The last segment of `typeId` — what a role's tail word is read from. */
  shortName: string;
  symbolKind: SymbolDefinitionKind;
  line: number;
  reopens: boolean;
  /** The ancestors the declaration names, in clause order; empty when it names none. */
  supertypes: readonly string[];
  /**
   * The declaration's member census, `TypeMemberCensus` (migration 040, bd
   * tea-rags-mcp-ffxfc). Both-or-neither; absent = the walker took none.
   */
  methodCount?: number;
  fieldCount?: number;
}

/** One file's type-declaration rows, as consumed by `GraphDbClient.replaceTypeDeclarationsBulk`. */
export interface TypeDeclarationReplaceEntry {
  relPath: RelPath;
  rows: readonly TypeDeclarationRow[];
}

/**
 * Files an evidence read never reads (bd tea-rags-mcp-vi0wx, spec §6.4): diff
 * mode's changed files, so a changed file is judged against the project and
 * not against the copy of itself an incremental reindex already stored.
 * Bounded by the diff cap (200 files), so it travels as a bind list; absent or
 * empty = no file is excluded.
 */
export interface IdentifierEvidenceExclusion {
  excludePaths?: readonly string[];
}

/**
 * Restricts an identifier read to rows whose file language
 * (`cg_symbols_files.language`) is one of `languages` (bd tea-rags-mcp-0qaht):
 * a draft's evidence stays within its language namespace, so Ruby locals never
 * vote on a TypeScript field. Absent = every language; empty = no rows (as
 * `readTypeNameRows` reads it). A row whose file language is unknown (no files
 * row) is kept: nothing places it in another language, and the lexicon cases
 * it as the answer's own.
 */
export interface IdentifierLanguageScope {
  languages?: readonly string[];
}

/**
 * The scope of an identifier read: the effective types asked for, optionally
 * narrowed to files under any of `pathPrefixes` (a literal rel_path prefix).
 */
export interface IdentifierTypeScopeQuery extends IdentifierEvidenceExclusion, IdentifierLanguageScope {
  types: readonly string[];
  pathPrefixes?: readonly string[];
}

/**
 * Opt-in on an identifier aggregate: split every group by its file language
 * (`cg_symbols_files.language`) and report it per row as `language`. A reader
 * that cases each row in its own language (a mixed Ruby + TypeScript project)
 * asks for it; without it rows carry no `language` key.
 */
export interface IdentifierLanguageGroupingQuery {
  groupByLanguage?: boolean;
}

/** {@link IdentifierTypeScopeQuery} for the type aggregate, which may group by file language. */
export interface IdentifierTypeAggregateQuery extends IdentifierTypeScopeQuery, IdentifierLanguageGroupingQuery {
  /**
   * Split every group by `type_multiplicity` and report it per row as
   * `typeMultiplicity` — a `Doc` value and a `Doc[]` value are judged apart
   * (bd tea-rags-mcp-4p3sb.26). Without it rows carry no `typeMultiplicity` key.
   */
  groupByMultiplicity?: boolean;
  /**
   * Report per non-`return` row `sameTypeSiblingN`: of its `n` rows, those
   * whose owner (same file, same owner symbol) binds the same type under
   * ANOTHER name in a non-`return` row — the co-occurrence that confirms a
   * QUALIFIED name (`source_node` beside `node`). A `return` row is the
   * method's name, not a value binding: it neither counts nor carries the key.
   * Without the flag no row carries it.
   */
  countSameTypeSiblings?: boolean;
  /**
   * Report per row `holders`: the group's distinct owner symbols (bd
   * tea-rags-mcp-bjfa0) — three locals of one method are one holder. Without
   * the flag no row carries it.
   */
  countHolders?: boolean;
}

/**
 * The file language of an aggregate row read with `groupByLanguage`: null for a
 * file with no `cg_symbols_files` row; absent when the read did not group.
 */
export interface IdentifierLanguageGroupedRow {
  language?: string | null;
}

/**
 * Callees asked for by `GraphDbClient.aggregateIdentifiersByCallee`. A callee
 * without `receiver` matches the member under ANY receiver, receiverless
 * included.
 */
export interface IdentifierCalleeScopeQuery
  extends IdentifierLanguageGroupingQuery, IdentifierEvidenceExclusion, IdentifierLanguageScope {
  callees: readonly IdentifierBoundCallee[];
  pathPrefixes?: readonly string[];
  /**
   * Report per row `holders`: the group's distinct owner symbols (bd
   * tea-rags-mcp-bjfa0) — three locals of one method are one holder. Without
   * the flag no row carries it.
   */
  countHolders?: boolean;
}

/**
 * One (type, kind, name, typeSource) group of the type aggregate. `typeSource`
 * is `call-return` for a row the query typed through its bound call's single
 * exact target. `exampleOwner` is the smallest owner symbolId of the group.
 */
export interface IdentifierTypeAggregateRow extends IdentifierLanguageGroupedRow {
  typeName: string;
  kind: IdentifierDeclarationKind;
  name: string;
  typeSource: IdentifierTypeSource;
  /** `cg_identifiers.type_multiplicity`, for a read that groups by it; absent otherwise. */
  typeMultiplicity?: IdentifierTypeMultiplicity;
  n: number;
  exampleOwner: SymbolId;
  /** Of `n`, the rows beside a second binding of the type — a `countSameTypeSiblings` read, non-`return` rows only. */
  sameTypeSiblingN?: number;
  /** The group's distinct owner symbols — a `countHolders` read only. */
  holders?: number;
}

/**
 * One (callee, kind, name, persisted type) group of the callee aggregate;
 * `receiver` is null for a receiverless call. `typeName` is the rows' PERSISTED
 * type (a `finder` row carries its receiver constant) and is absent for untyped
 * rows — the callee path answers for values the type path cannot name.
 */
export interface IdentifierCalleeAggregateRow extends IdentifierLanguageGroupedRow {
  member: string;
  receiver: string | null;
  kind: IdentifierDeclarationKind;
  name: string;
  n: number;
  exampleOwner: SymbolId;
  typeName?: string;
  /** The group's distinct owner symbols — a `countHolders` read only. */
  holders?: number;
}

/** A typed `param` / `return` row of an anchor symbol. */
export interface AnchorIdentifierTypeRow {
  ownerSymbolId: SymbolId;
  kind: "param" | "return";
  typeName: string;
}

/** How many rows bind `name` to `typeName` (null: untyped even after the call-return join). */
export interface IdentifierNameTypeRow {
  name: string;
  typeName: string | null;
  n: number;
}

/** A read over every identifier row, optionally narrowed to files under any of `pathPrefixes`. */
export interface IdentifierScopeQuery extends IdentifierEvidenceExclusion, IdentifierLanguageScope {
  pathPrefixes?: readonly string[];
}

/** Names asked for by `GraphDbClient.aggregateIdentifiersByName`, scoped like {@link IdentifierScopeQuery}. */
export interface IdentifierNameScopeQuery extends IdentifierScopeQuery, IdentifierLanguageGroupingQuery {
  names: readonly string[];
  /** Report per row `holders`, the group's distinct owner symbols (bd tea-rags-mcp-bjfa0). */
  countHolders?: boolean;
}

/**
 * One (name, kind, effective type) group of the name aggregate. `typeName` is
 * null for rows untyped even after the call-return join — the rows the naming
 * lexicon's `name-inferred` stage may type.
 */
export interface IdentifierNameKindTypeRow extends IdentifierLanguageGroupedRow {
  name: string;
  kind: IdentifierDeclarationKind;
  typeName: string | null;
  /** `cg_identifiers.type_multiplicity`, for a read that groups by it; absent otherwise. */
  typeMultiplicity?: IdentifierTypeMultiplicity;
  n: number;
  exampleOwner: SymbolId;
  /** The group's distinct owner symbols — a `countHolders` read only. */
  holders?: number;
}

/**
 * The language-count read's scope: {@link IdentifierScopeQuery}, further
 * narrowed to rel_paths ending in any of `pathSuffixes` (`.rb`) — the file
 * extension a request's path pattern pins. Absent or empty → no suffix narrowing.
 */
export interface IdentifierLanguageCountQuery extends IdentifierScopeQuery {
  pathSuffixes?: readonly string[];
}

/** Identifier rows per file language (`cg_symbols_files.language`; null for a file with no files row). */
export interface IdentifierLanguageCountRow {
  language: string | null;
  n: number;
}

/** A bounded sample of the scope's evidence-carrying rows (`GraphDbClient.sampleIdentifierShapes`). */
export interface IdentifierShapeSampleQuery extends IdentifierScopeQuery, IdentifierLanguageGroupingQuery {
  /** Reservoir size in rows; a scope with fewer rows is read whole. */
  limit: number;
}

/**
 * One (kind, name, persisted type, bound callee) group of the sampled rows. A
 * sampled row carries a persisted type or a bound callee — a row with neither
 * can only classify as a role name, so it is not evidence of a convention.
 */
export interface IdentifierShapeSampleRow extends IdentifierLanguageGroupedRow {
  kind: IdentifierDeclarationKind;
  name: string;
  typeName: string | null;
  /** `cg_identifiers.type_multiplicity`, for a read that groups by it; absent otherwise. */
  typeMultiplicity?: IdentifierTypeMultiplicity;
  boundMember: string | null;
  boundReceiver: string | null;
  n: number;
}

// ── Method-name reads over cg_symbols (naming coverage for untyped methods) ──

/**
 * A read over declared method / function names (`cg_symbols`, symbol_kind
 * `method` | `function`), production files only. Constructors
 * (`initialize`, `constructor`, `__init__`) are never read.
 */
export interface MethodNameScopeQuery extends IdentifierScopeQuery, IdentifierLanguageGroupingQuery {
  nonProductionPaths: TypeNameQuery["nonProductionPaths"];
}

/**
 * Head words of multi-word method names — the leading lowercase run before `_`
 * or a capital (`update_user`, `updateUser` → `update`) — that open at least
 * `minTails` distinct noun tails (tail normalized across casings, trailing
 * `!` / `?` dropped). The candidates a language namespace's verb lexicon is
 * derived from (spec §D4a).
 */
export interface MethodHeadWordQuery extends MethodNameScopeQuery {
  minTails: number;
}

/** Noun tails more than one of `heads` opens (`load_user` and `fetch_user` contest `user`). Empty `heads` reads nothing. */
export interface MethodTailVerbQuery extends MethodNameScopeQuery {
  heads: readonly string[];
}

/** Names matching any of `patterns` (RE2, anchored by the caller). Empty `patterns` reads nothing. */
export interface MethodNamePatternQuery extends MethodNameScopeQuery {
  patterns: readonly string[];
}

/**
 * One head word of {@link MethodHeadWordQuery}: `headHolders` = distinct method
 * symbols whose name it opens, `headTails` = distinct noun tails after it,
 * `lastHolders` = distinct method symbols of two or more words whose LAST word
 * it is (`load_user`, `loadUser` → `user`), `valueCompounds` = distinct
 * compound names it opens (trailing `!` / `?` / `=` dropped) that also name a
 * value: a non-`return` `cg_identifiers` row of the same evidence scope (and
 * file language, when grouped) whose name, a leading `@` / `@@` dropped, equals
 * the compound (`media_attachment` beside `@media_attachment`).
 */
export interface MethodHeadWordRow extends IdentifierLanguageGroupedRow {
  head: string;
  headHolders: number;
  headTails: number;
  lastHolders: number;
  valueCompounds: number;
}

/**
 * One (tail, head) pair of {@link MethodTailVerbQuery}: `tail` is the
 * normalized noun tail (lowercase, no `_`), `holders` = distinct method
 * symbols, `name` = the pair's most-held spelling (ties by name).
 */
export interface MethodTailVerbRow extends IdentifierLanguageGroupedRow {
  tail: string;
  head: string;
  holders: number;
  name: string;
}

/** One method name matched by {@link MethodNamePatternQuery}; `holders` = distinct method symbols. */
export interface MethodNameRow extends IdentifierLanguageGroupedRow {
  shortName: string;
  holders: number;
}

// ── Ontology audit over cg_identifiers (bd tea-rags-mcp-4p3sb.20) ──

/** A section of the project-wide naming ontology audit ({@link GraphDbClient.readOntologyReportSections}). */
export type OntologyReportSection = "synonyms" | "homonyms" | "outliers" | "collisions";

/** How a declared name collides with a symbol the graph already holds. */
export type OntologyCollisionRule =
  /**
   * A typed value named after a type-like symbol that is neither its type nor
   * related to it by inheritance. A symbol owning a `return` row is callable,
   * not a type; a PascalCase function with no declared or inferred return type
   * still reads as one — casing is all the graph has on it.
   */
  | "namesOtherType"
  /**
   * A local named like an instance method of its owner's class, only in a
   * language whose naming descriptor declares `implicitSelf` — elsewhere a bare
   * name cannot reach the method, so nothing is shadowed.
   */
  | "shadowsMethod";

/**
 * Type names that carry no domain concept, for the files with any of
 * `extensions` (`.rb`) — one entry per language, from its naming descriptor.
 */
export interface OntologyNonConceptTypes {
  extensions: readonly string[];
  typeNames: readonly string[];
}

/** The judging thresholds of {@link OntologyReportQuery}; policy, owned by the caller. */
export interface OntologyReportThresholds {
  /** Rows a (type, kind) group or a name needs before it is judged at all. */
  minSupport: number;
  /** Synonyms: a group whose top name holds at least this share of its rows is consistent. */
  synonymDominantShareCeiling: number;
  /** Generic name: bound to at least this many distinct concept types… */
  genericMinTypes: number;
  /** …none of which holds this share of the name's rows. */
  genericMaxTopTypeShare: number;
  /** Homonyms: a type counts for a name when it holds at least this many rows… */
  homonymMinTypeRows: number;
  /** …and at least this share of the name's rows. */
  homonymMinTypeShare: number;
  /** Outliers: a group is a convention when its top name holds at least this share. */
  outlierMinDominantShare: number;
  /** `k` of the `(n/k)^2` confidence the sections rank by. */
  confidenceSupport: number;
  /** Names returned per synonym / outlier group; types per homonym, applied by the caller after its judgement. */
  namesPerItem: number;
  /**
   * Candidate (type, kind) groups read for synonyms and outliers, and candidate
   * names read for homonyms, before the caller's plural / spelling merge and
   * shape judgement narrow them to `limit`.
   */
  groupPool: number;
}

/**
 * Scope and policy of one ontology read. Rows count as evidence only when their
 * EFFECTIVE type (persisted or `call-return`) is a concept type — not a
 * `nonConceptTypes` entry of the row's language, not a single capital letter —
 * and their kind is `param`, `local` or `field`. A name bound to many types in
 * the scope is a generic candidate (thresholds); the names the caller judges
 * generic are excluded from every section.
 */
export interface OntologyReportQuery extends IdentifierEvidenceExclusion {
  /** Literal `rel_path` prefixes; empty / absent = the whole project. */
  pathPrefixes?: readonly string[];
  /** File extensions (`.rb`, lowercase) a row's file must carry — the language filter. */
  extensions?: readonly string[];
  /**
   * Only rows carrying one of these names — the naming lexicon asks whether
   * its drafts are generic without reading the project's every candidate.
   * Per-name aggregates are unchanged by it; absent = every name.
   */
  names?: readonly string[];
  nonConceptTypes: readonly OntologyNonConceptTypes[];
  /**
   * The non-production masks the scope drops — tooling directories and test
   * shapes, split by case matching (`nonProductionPathPatterns`). A field, not
   * a store constant: the per-language test shapes are owned by
   * `domains/language` and the store may run in the codegraph daemon, so the
   * caller hands them in (bd tea-rags-mcp-vjz6s).
   */
  nonProductionPaths: CaseSplitPathPatterns;
  /**
   * File extensions (lowercase, dot included) of the languages where a local
   * can shadow a method — those declaring `IdentifierNamingConvention.implicitSelf`.
   * The `shadowsMethod` collision reads only these files; empty = the rule is off.
   */
  shadowsMethodExtensions: readonly string[];
  sections: readonly OntologyReportSection[];
  /** Items per section (collisions: per rule). */
  limit: number;
  thresholds: OntologyReportThresholds;
}

/** Where one example row of an ontology finding sits. */
export interface OntologyLocationRow {
  relPath: RelPath;
  line: number;
  ownerSymbolId: SymbolId;
}

/** Rows behind a finding per effective type source; `untyped` only for `shadowsMethod` collisions. */
export type OntologyEvidenceCounts = Partial<Record<IdentifierTypeSource | "untyped", number>>;

/** One name of a group with its row count and the example row. */
export interface OntologyNameCountRow {
  name: string;
  n: number;
  example: OntologyLocationRow;
}

/** A (type, kind) group: its names, most frequent first, capped at `namesPerItem`. */
export interface OntologyTypeGroupRow {
  typeName: string;
  kind: Exclude<IdentifierDeclarationKind, "return">;
  /**
   * `cg_identifiers.type_multiplicity`, for a read that groups by it — a `Doc`
   * group and a `Doc[]` group are different roles (bd tea-rags-mcp-4p3sb.26);
   * absent otherwise.
   */
  typeMultiplicity?: IdentifierTypeMultiplicity;
  n: number;
  distinctNames: number;
  /** Share of the group's rows its top name holds. */
  dominantShare: number;
  /** Shannon entropy of the name distribution over ALL names, normalised by `ln(distinctNames)` to 0..1. */
  entropy: number;
  names: OntologyNameCountRow[];
  evidence: OntologyEvidenceCounts;
}

/** A name bound to two or more concept types, each with non-trivial support. */
export interface OntologyHomonymRow {
  name: string;
  n: number;
  /** Share of the name's rows its most frequent type holds. */
  topTypeShare: number;
  types: { typeName: string; n: number; example: OntologyLocationRow }[];
  evidence: OntologyEvidenceCounts;
}

/** A declared name that collides with a symbol short name. */
export interface OntologyCollisionRow {
  rule: OntologyCollisionRule;
  name: string;
  /** The collided symbol: a type-like short name (`namesOtherType`) or the method's symbolId (`shadowsMethod`). */
  symbol: string;
  /** The declared type — always set for `namesOtherType`, absent for `shadowsMethod`. */
  typeName?: string;
  n: number;
  example: OntologyLocationRow;
  evidence: OntologyEvidenceCounts;
}

/** One type a generic-name candidate is bound to; `relPath` is an example file, for the language casing. */
export interface OntologyGenericNameTypeRow {
  typeName: string;
  n: number;
  relPath: string;
}

/**
 * A generic-name candidate — generic by type count alone. The caller drops the
 * types the name spells (`form` over `ActionForm`, `ClientForm`), keeps it only
 * when the unrelated types still make it generic, and passes the names it kept
 * to {@link GraphDbClient.readOntologyReportSections} as the exclusion.
 */
export interface OntologyGenericNameRow {
  name: string;
  typeCount: number;
  n: number;
  /** Every type the name is bound to, largest first. */
  types: OntologyGenericNameTypeRow[];
}

/** What {@link GraphDbClient.readOntologyReportSummary} read. */
export interface OntologyReportSummaryRows {
  /** Whole-table counts, unscoped — `identifierRows: 0` beside `symbolRows > 0` is an index predating the table. */
  totals: { identifierRows: number; symbolRows: number };
  /** Generic-name candidates — `genericNames.length`. */
  genericNameCount: number;
  /** Every generic-name candidate of the scope, most frequent first, uncapped: the caller judges and caps them. */
  genericNames: OntologyGenericNameRow[];
}

/** What {@link GraphDbClient.readOntologyReportSections} read; a section is present only when requested. */
export interface OntologyReportSectionRows {
  /** Concept-typed rows of the scope minus the excluded generic names — the evidence every section draws from. */
  evidenceRows: number;
  synonyms?: OntologyTypeGroupRow[];
  /** Candidate names (up to `groupPool`, every qualifying type); the caller judges and caps them. */
  homonyms?: OntologyHomonymRow[];
  /** Candidate groups (a dominant name exists); the caller judges shapes. */
  outlierGroups?: OntologyTypeGroupRow[];
  collisions?: OntologyCollisionRow[];
}

/** Both phases of one ontology read, as the caller assembles them. */
export type OntologyReportRows = OntologyReportSummaryRows & OntologyReportSectionRows;

/**
 * The scope of {@link GraphDbClient.readTypeNameRows} (bd tea-rags-mcp-vi0wx):
 * the type-level symbols the naming lexicon derives type roles from.
 */
export interface TypeNameQuery {
  /** Literal `rel_path` prefixes, as {@link OntologyReportQuery.pathPrefixes}; empty = the whole project. */
  pathPrefixes: readonly string[];
  /**
   * Files whose rows are never read — diff mode's changed files, so a draft is
   * judged against the project and not against itself. Bounded by the diff cap
   * (200 files), so it travels as a bind list.
   */
  excludePaths?: readonly string[];
  /** The symbol kinds to read — the type-level ones. A row of unknown kind (`NULL`, pre-035) is never read. */
  kinds: readonly SymbolDefinitionKind[];
  /**
   * The file languages to read (bd tea-rags-mcp-icuxg) — one type namespace, so
   * a draft is never judged against a namesake it could not collide with.
   * Absent = every language.
   */
  languages?: readonly string[];
  /** The non-production masks the scope drops, as {@link OntologyReportQuery.nonProductionPaths}. */
  nonProductionPaths: CaseSplitPathPatterns;
}

/** One type-level symbol with its inheritance ancestors (`ancestor_fq_name`, declaration order). */
export interface TypeNameRow {
  symbolId: string;
  relPath: string;
  shortName: string;
  symbolKind: SymbolDefinitionKind;
  ancestors: readonly string[];
  /**
   * How many of the TYPE's members are methods and how many are fields (bd
   * tea-rags-mcp-ffxfc): the sum over every production declaration of the same
   * language and type id — a Ruby class body re-opened in another file, a
   * re-opening that adds members — so every row of one type carries the same
   * pair. Both-or-neither; absent = unknown, no declaration of the type carries
   * a census (an index written before migration 040, a walker that takes none).
   */
  methodCount?: number;
  fieldCount?: number;
}

/**
 * Resolved location of a symbol's covering Qdrant chunk. Returned by
 * `GraphDbClient.findSymbolChunk` — null when no chunk_id has been
 * backfilled for the symbol yet.
 */
export interface SymbolChunkLocation {
  relPath: RelPath;
  chunkId: string;
}

/**
 * A symbol's walker range (1-based, inclusive) — the input of the chunk-owner
 * rule every producer of `codegraph.symbols.chunk.*` settles through (bd
 * tea-rags-mcp-9i2ow, 39xca.2). Persisted as `cg_symbols.start_line` /
 * `end_line` (migration 024) and read back by
 * {@link GraphDbClient.getSymbolLineRangesBulk}.
 */
export interface SymbolLineRange {
  symbolId: SymbolId;
  startLine: number;
  endLine: number;
}

/**
 * What `cg_symbols` holds for one file's symbol ranges: every ranged row, and
 * how many rows carry a NULL range (written before migration 024). The count is
 * what tells "rows the chunk-owner rule cannot place" from "no rows at all" — a
 * file with no row is absent from the read — and the two settle differently
 * (bd tea-rags-mcp-39xca.2).
 */
export interface PersistedSymbolLineRanges {
  ranges: SymbolLineRange[];
  rowsWithoutRanges: number;
}

/**
 * Narrow read seam for the find_symbol codegraph fallback (0rskm). Lives in
 * contracts so domains/explore can depend on it without importing api/internal
 * or adapters. Implemented by GraphFacade (adapted to a bare collectionName in
 * bootstrap). Undefined injection = codegraph disabled = fallback no-op.
 */
export interface SymbolChunkResolver {
  resolveSymbolChunk: (collectionName: string, symbolId: SymbolId) => Promise<SymbolChunkLocation | null>;
}

/**
 * The read seam the find_symbol outline uses to show each member's DECLARED
 * visibility (bd tea-rags-mcp-sqqkz) — one batched read per outline response.
 * May throw when the graph exists but cannot be read; the outline degrades to
 * its undecorated form. Absent when codegraph is disabled.
 */
export interface SymbolVisibilityResolver {
  resolveSymbolVisibilities: (collectionName: string, symbolIds: readonly SymbolId[]) => Promise<SymbolVisibilityRow[]>;
}

/**
 * One symbol whose derived codegraph signals moved since the previous run's
 * baseline (bd tea-rags-mcp-a2ddb). Carries the FILE as well as the symbol
 * because the payload is addressed per file's Qdrant points — a bare
 * `symbolId` is unique per file, not per repository, so it cannot name the
 * points to rewrite on its own.
 */
export interface ChangedSymbolSignal {
  relPath: RelPath;
  symbolId: SymbolId;
}

/** One file whose derived file-level codegraph signals moved since the baseline. */
export interface ChangedFileSignal {
  relPath: RelPath;
}

/**
 * What {@link GraphDbClient.diffSymbolSignals} found: the symbols and the files
 * whose derived signals differ from the baseline the last successful payload
 * heal recorded. Both halves are plain arrays rather than Maps or Sets so the
 * shape survives the daemon's JSON round trip.
 */
export interface CodegraphSignalDrift {
  symbols: ChangedSymbolSignal[];
  files: ChangedFileSignal[];
}

/**
 * Size of a graph store as the compaction decision reads it (bd
 * tea-rags-mcp-dvzdm): the rows every table answers to `count(*)`, the row
 * versions its storage still holds (live plus deleted-but-unreclaimed), and the
 * file's bytes on disk.
 */
export interface CodegraphStorageFootprint {
  liveRows: number;
  storedRows: number;
  fileBytes: number;
}

/**
 * How one {@link GraphDbClient.compactStorage} call settled. Plain data, so it
 * survives the daemon's JSON round trip.
 *
 * - `belowThreshold` — the store is small, or mostly live rows; nothing to gain.
 * - `streamOpen` — a stream was reading the file on its own connection; the
 *   next run tries again.
 * - `unsupported` — a daemon from a build that predates the operation.
 */
export type CodegraphStorageCompactionOutcome =
  | {
      readonly kind: "skipped";
      readonly reason: "belowThreshold" | "streamOpen" | "unsupported";
      readonly footprint?: CodegraphStorageFootprint;
    }
  | {
      readonly kind: "compacted";
      readonly bytesBefore: number;
      readonly bytesAfter: number;
      readonly liveRows: number;
      readonly storedRows: number;
      readonly durationMs: number;
    };

/**
 * One working-tree file edge of one diff-scoped review (bd
 * tea-rags-mcp-89k7k.1.2): the changed file imports/knows the target file.
 * Lived in the slice-A overlay module (`api/internal/ops/review-edge-overlay`)
 * until the persistence slice needed it too — the adapters layer may not
 * import api, so the shared shape belongs here, beside the other
 * {@link GraphDbClient} call shapes.
 *
 * The export-name fields (bd tea-rags-mcp-89k7k.1.6) mirror
 * `FileEdgeExportNames` with the same absence semantics: absent = not
 * recorded, never read as "names nothing". They are in-memory judgement input
 * for the diff detectors only — the review edge store persists source and
 * target alone, so neither field round-trips a table.
 */
export interface ReviewFileEdge {
  sourceRelPath: string;
  targetRelPath: string;
  /** The names this edge's import statements take from the target's export surface, unioned per target. */
  importedExportNames?: string[];
  /** The names this edge's statements re-export out of the target — the facade-contract detector's supply side. */
  reexportedExportNames?: string[];
}

/**
 * Driver-agnostic graph DB client.
 *
 * Slice 1 ships `DuckDbGraphClient`; slice 4 ships `PostgresGraphClient`.
 * The interface is the contract — driver-specific concerns (transaction
 * style, prepared statement caching) are implementation details.
 */
export interface GraphDbClient {
  init: () => Promise<void>;
  close: () => Promise<void>;

  /** Atomic upsert of file row + all outgoing edges. Used by the streaming
   *  write path. */
  upsertFile: (node: GraphFileNode, edges: GraphEdges) => Promise<void>;

  /** Batched `upsertFile`: fold M files' node + edge writes into ONE
   *  transaction (and, on the daemon, one IPC round-trip). Each file keeps its
   *  own per-`source_rel_path` DELETE+INSERT (last-wins), so the persisted rows
   *  are identical to calling `upsertFile` per file. Empty batch is a no-op. */
  upsertFilesBulk: (entries: readonly BulkFileUpsertEntry[]) => Promise<void>;

  /** Used by incremental reindex when a file is removed from disk. */
  removeFile: (relPath: RelPath) => Promise<void>;

  /** Reads for metric computation (Tier 1) and MCP tools. */
  getFanIn: (relPath: RelPath) => Promise<number>;
  getFanOut: (relPath: RelPath) => Promise<number>;

  /**
   * Collection-wide p95 of per-file fanIn over the FULL file universe
   * (every row in `cg_symbols_files`, including files with zero incoming
   * edges). Used at index time to finalise `codegraph.file.isHub`
   * (`fanIn > p95`). Computed against the whole graph — not the
   * incremental-reindex subset — so hub classification stays correct when
   * only a few files changed. Returns 0 on an empty/single-file graph so
   * the `fanIn > p95` comparison degenerates sanely.
   */
  getFanInP95: () => Promise<number>;
  getCallers: (symbolId: SymbolId) => Promise<CallerEdge[]>;
  getCallees: (symbolId: SymbolId) => Promise<CalleeEdge[]>;
  /**
   * Lazy ambiguous-group expansion (bd tea-rags-mcp-f2jsb A4). Reads the
   * `cg_ambiguous_fanout` aggregates whose `member` matches the target's
   * member segment — call sites whose over-cap candidate set plausibly
   * contained the target — WITHOUT materializing the suppressed edges.
   * Ordered by (sourceSymbolId, sourceRelPath, callExpression) — a namesake
   * caller in another file is its own aggregate (migration 027); `limit`
   * defaults to 50.
   * Empty `member` always returns [] (aggregates never record one).
   */
  getAmbiguousCallersByMember: (member: string, limit?: number) => Promise<AmbiguousCallerSite[]>;
  /**
   * Batch adjacency: for each input source symbolId, the list of resolved
   * callee target symbolIds. Method edges whose callee could not be resolved
   * to a known symbol (null `target_symbol_id`) are excluded. Used by
   * trace_path to expand the call frontier level-by-level without
   * materialising the whole method graph. Sources with no resolved callees
   * are simply absent from the returned map.
   */
  getCalleeEdges: (symbolIds: SymbolId[]) => Promise<Map<SymbolId, SymbolId[]>>;
  /**
   * File-scoped batch adjacency (bd tea-rags-mcp-oxnvl) — same frontier
   * expansion as {@link getCalleeEdges}, but node identity is
   * `(relPath, symbolId)` instead of the bare symbolId. Top-level declarations
   * carry unqualified ids, so the bare form merges every namesake into one node
   * and lets a traced path cross between unrelated files; this form keeps them
   * apart. Targets are DISTINCT — one entry per edge, not per call site.
   * Sources with no visible callees are absent from the map.
   */
  getCalleeEdgesScoped: (refs: FileScopedSymbolRef[]) => Promise<Map<FileScopedSymbolId, FileScopedSymbolRef[]>>;
  /**
   * Files each symbol appears in, as call source or call target (bd
   * tea-rags-mcp-oxnvl). Resolves a bare symbolId to the concrete graph nodes
   * it could denote — several entries mean namesakes. Symbols absent from the
   * method-edge table are absent from the map.
   */
  getSymbolRelPaths: (symbolIds: SymbolId[]) => Promise<Map<SymbolId, RelPath[]>>;
  /**
   * Confidence-weighted chunk fanIn (bd tea-rags-mcp-s5ato):
   * SUM(confidence) over incoming method edges — an m-way dynamic/cone
   * fan-out at confidence 1/m contributes ~1 in total, not m. May be
   * FRACTIONAL (e.g. 1.25); rounded to 2 decimals at the adapter boundary.
   */
  getCalledByCount: (symbolId: SymbolId) => Promise<number>;
  /**
   * Confidence-weighted chunk fanOut — SUM(confidence) over outgoing
   * method edges (a whole m-way fan-out counts as ONE outgoing call).
   * Same fractional/rounding semantics as `getCalledByCount`.
   */
  getCallSiteCount: (symbolId: SymbolId) => Promise<number>;
  /**
   * Bulk read-back of `{ fanIn, fanOut, pageRank }` for EVERY symbol in the
   * graph, keyed by {@link fileScopedSymbolKey} — the set-based replacement for
   * the per-chunk `getCalledByCount` + `getCallSiteCount` + `getPageRank` loop
   * in `buildChunkSignals` (the deferred-chunk tail). Three GROUP-BY / scan
   * queries instead of `3 × chunkCount` point queries. A symbol absent from the
   * map reads as `{ 0, 0, 0 }` (matching the getters, which each return 0 on no
   * rows).
   *
   * The key is `(relPath, symbolId)` and NOT the bare symbolId, because a
   * symbolId is unique per file: the bare form merged every top-level namesake
   * into one node and stamped the union of their edges on each (bd
   * tea-rags-mcp-xtdkq, same defect class as the migration-020 primary key).
   * The per-symbol getters above still answer the merged number and have no
   * production caller left; do not reintroduce one.
   *
   * `pageRank` is the residual: it is stored per bare symbol_id and computed
   * over an adjacency of bare ids, so every namesake shares one rank and the
   * bulk read hands each declaration that same value.
   */
  getChunkSignalsBulk: () => Promise<Map<FileScopedSymbolId, ChunkGraphSignals>>;

  // ── Class hierarchy (bd tea-rags-mcp-f10y) ──
  /** Direct ancestors of a type (forward), ordered by declaration ordinal. */
  getSupertypes: (fqName: string) => Promise<InheritanceEdge[]>;
  /** Direct subtypes / implementers of a type (reverse index). */
  getSubtypes: (fqName: string) => Promise<InheritanceEdge[]>;
  /** Transitive subtypes via recursive CTE; `depth` reflects traversal level. */
  getTransitiveSubtypes: (fqName: string) => Promise<InheritanceEdge[]>;
  /** Bulk load both directions for the resolver snapshot. */
  loadHierarchySnapshot: () => Promise<HierarchySnapshot>;

  /** Returns true if at least one row exists in `cg_symbols_files`. Used
   *  by drift detection. */
  hasData: () => Promise<boolean>;

  /**
   * Drop and recreate `cg_symbols_edges_file`'s `target_rel_path` secondary
   * index in place (tea-rags-mcp-wgt19). That index earns its cost on read
   * (`getFanIn`, once per file during enrichment) but is exposed to the same
   * ART-drift class 019 removed from other tables: a run dying mid-write
   * (killed daemon, invalidated database, aborted pass — all recurring here)
   * can leave it answering a scoped `DELETE ... WHERE target_rel_path`-style
   * filter pushdown with stale results, so a later per-file DELETE silently
   * matches nothing while the row it was meant to clear is still present, and
   * the following INSERT collides with it — live-reproduced as a daemon-
   * killing native FatalException against taxdome. 019 kept this index rather
   * than dropping it outright because removing it costs every `getFanIn` call
   * a full scan; rebuilding it periodically during a long write-heavy pass
   * keeps that read-time win while bounding how long drift has to accumulate
   * before it is corrected. Call cadence is the caller's choice — the graph
   * finalizer's own `checkpoint()` is a natural one, since a run short enough
   * to never checkpoint is also too short to have meaningfully drifted.
   */
  rebuildEdgeFileTargetIndex: () => Promise<void>;

  // ── Resolve-stats surface (bd tea-rags-mcp-j431) ──
  /**
   * Replace the legacy `cg_run_stats` rows of every language the supplied
   * breakdown names. Overwrite (not merge) per language: stale kinds from a
   * prior run must not survive, and a language absent from `rows` is untouched.
   * A whole-corpus measurement — the codegraph provider calls it only for runs
   * that resolved a language's whole corpus (bd tea-rags-mcp-xpmwg); it is read
   * only for languages {@link recordFileResolveStats} has not yet covered.
   */
  recordRunStats: (rows: ResolveRunStatsRow[]) => Promise<void>;
  /**
   * Persist one run's per-file resolve tallies (bd tea-rags-mcp-xpmwg) in ONE
   * transaction: each named file's `cg_file_resolve_stats` rows become exactly
   * the rows its entry carries (an empty entry clears them), every other file's
   * rows are untouched, and `completeLanguages` is recorded as covered. Deleting
   * a file (`removeFile`) drops its rows. A write naming no file and no language
   * is a no-op.
   */
  recordFileResolveStats: (write: FileResolveStatsWrite) => Promise<void>;
  /**
   * Read the persisted per-(language, receiver-kind) resolve breakdown, ordered
   * by language then receiver kind. A language a whole-corpus run has covered is
   * the SUM of its per-file tallies; every other language reads its legacy
   * `cg_run_stats` rows. Empty array before any run is recorded. Routed through
   * the daemon proxy so MCP clients can read it without holding the DuckDB lock.
   */
  getRunStats: () => Promise<ResolveRunStatsRow[]>;
  /**
   * Count emitted method edges grouped by `edge_kind` (exact / cone / poly-base
   * / dynamic / registry). The exact-vs-fan-out split is a precision-confidence
   * signal: `exact` edges are pinned to a single target, the rest are
   * over-approximations with confidence < 1. Routed through the daemon proxy.
   */
  getEdgeKindDistribution: () => Promise<EdgeKindCount[]>;

  // ── Symbol-table persistence (Slice 2 / A4c) ──
  // The in-memory GlobalSymbolTable needs a disk-backed copy so cold
  // starts and partial reindexes can hydrate without re-walking every
  // file in the repo. Persistence is keyed by `(relPath, symbolId)`
  // exactly like the in-memory map.

  /** Atomic replacement of all symbols for a file, reconciled as a row diff
   *  inside one transaction. Idempotent: empty `definitions` clears the file,
   *  and a re-walk producing the rows already on disk touches nothing. */
  upsertSymbols: (relPath: RelPath, definitions: SymbolDefinition[]) => Promise<void>;

  /** Batched form of {@link upsertSymbols}: one transaction reconciling every
   *  relPath the batch names against the rows it carries. Same per-file
   *  semantics; empty entries is a no-op. If `entries` carries more than one
   *  entry for the same `relPath`, the last one wins — == calling
   *  `upsertSymbols` sequentially for that path.
   *
   *  A symbol's `chunk_id` is NOT part of the reconciliation: an unchanged row
   *  keeps the join {@link updateSymbolChunkIdsBulk} wrote, and retiring a stale
   *  one is that call's job. */
  upsertSymbolsBulk: (entries: BulkSymbolUpsertEntry[]) => Promise<void>;

  /** Drop all persisted symbols for a file. Called by `handleDeletedPaths`. */
  removeSymbolsForFile: (relPath: RelPath) => Promise<void>;

  /**
   * Cheap derived-table prune for deleted files (bd tea-rags-mcp-dy852):
   * drop every cycle with a member in one of `relPaths` and those files'
   * PageRank rows, and mark the derived tables stale when any path was a
   * walked file. Called by `handleDeletedPaths` BEFORE the base rows go.
   */
  pruneDerivedForDeletedFiles: (relPaths: readonly RelPath[]) => Promise<void>;

  /**
   * Whether a deletion pruned the derived tables since the last full cycles +
   * PageRank recompute, which clears the mark.
   */
  hasStaleDerivedTables: () => Promise<boolean>;

  /** Bulk read for bootstrap hydration. Returns every persisted symbol
   *  definition; consumer is expected to feed them through
   *  `GlobalSymbolTable.hydrate`. */
  listAllSymbols: () => Promise<SymbolDefinition[]>;

  /**
   * The persisted per-file pass-1 aggregate rows of the languages `scope`
   * names (bd tea-rags-mcp-znxg8).
   *
   * Read ONCE per run, at the pass-1→pass-2 barrier, so `CodegraphRunState` can
   * absorb the ancestry and self-dispatch facts of files this run did NOT walk.
   * Without it an incremental run resolves against a complete symbol table and a
   * batch-sized registry, which does not merely under-resolve — it mis-resolves,
   * degrading concrete service entry calls onto the shared template they
   * inherit from.
   *
   * Scoped because the rows of a language no walked family reads are pure cost:
   * a TypeScript-only recompute on taxdome parsed and held 9,184 Ruby slices.
   * Array rather than Map so it survives the daemon's JSON round trip.
   */
  listPass1Aggregates: (scope: Pass1AggregateReadScope) => Promise<CodegraphPass1FileAggregates[]>;

  /**
   * The persisted hierarchy dependencies of `scope`'s languages (bd
   * tea-rags-mcp-7t2ee): per source file, which types' descendant sets its
   * resolution read and what it read. The pass-1→pass-2 barrier compares each
   * against the run's current hierarchy and re-resolves the files whose answer
   * moved. Scoped exactly like {@link listPass1Aggregates}, by the language of
   * the SOURCE file.
   */
  listHierarchyDependencies: (scope: Pass1AggregateReadScope) => Promise<PersistedHierarchyDescendantDependency[]>;

  /**
   * Before `relPaths` are removed (bd tea-rags-mcp-7t2ee): clear the content
   * hash of every OTHER file whose recorded hierarchy dependency lists a type
   * one of `relPaths` declares, so the drift repair re-extracts — and pass-2
   * re-resolves — the callers whose cone lost a member. A deletion-only run
   * opens no barrier, so this is the only place the removal can reach them.
   * Called by `handleDeletedPaths` BEFORE the base rows go, like
   * {@link pruneDerivedForDeletedFiles}.
   */
  invalidateHierarchyDependentsOfDeletedFiles: (relPaths: readonly RelPath[]) => Promise<void>;

  /**
   * Every file row with the content hash persisted alongside it, `null` where
   * the row predates the column (bd tea-rags-mcp-6goqa). The repair check diffs
   * this against the run's current hashes to decide what must be re-extracted.
   *
   * Returns an array rather than a Map because the daemon proxies this over
   * JSON, where a Map does not survive the round trip.
   */
  listFileContentHashes: () => Promise<{ relPath: RelPath; contentHash: string | null }[]>;

  /**
   * REPLACE the covering-chunk reference for the symbols of one file. UPDATE-
   * only — never rewrites identity columns. Keyed by symbolId; a symbol of that
   * file absent from the map ends with chunk_id NULL, so a stale join cannot
   * outlive the chunk it pointed at. Written in the codegraph deferred chunk
   * pass once chunk ids exist.
   */
  updateSymbolChunkIds: (relPath: RelPath, chunkIds: ReadonlyMap<SymbolId, string>) => Promise<void>;

  /**
   * Batched form of {@link updateSymbolChunkIds}: the whole deferred chunk
   * pass in ONE transaction of chunked set-based statements, instead of one
   * transaction (and one daemon round-trip) per file.
   *
   * Replace semantics apply per file the entries NAME: those files' chunk_id is
   * cleared, then the collected mapping applied, both inside the one
   * transaction. A file no entry names is untouched. Naming a file with an
   * empty map therefore means "re-derived, nothing covers it" and clears it.
   * Empty entries is a no-op; when one call carries the same (relPath,
   * symbolId) twice the LAST value wins.
   */
  updateSymbolChunkIdsBulk: (entries: readonly SymbolChunkIdJoinEntry[]) => Promise<void>;

  /**
   * Resolve a symbol to its covering Qdrant chunk. Indexed lookup by
   * symbol_id. Returns null when no row matches OR the row's chunk_id is NULL
   * (symbol exists but no covering chunk was recorded). Used by the
   * find_symbol codegraph fallback (0rskm) and promotable to primary (q383b).
   */
  findSymbolChunk: (symbolId: SymbolId) => Promise<SymbolChunkLocation | null>;

  /**
   * Declared visibility of every `cg_symbols` definition whose symbolId is in
   * `symbolIds` — namesakes in other files included, so the caller joins by
   * (relPath, symbolId). A NULL column is returned as `null` (unknown); an id
   * with no definition is absent. One batched read (bd tea-rags-mcp-sqqkz).
   */
  getSymbolVisibilities: (symbolIds: readonly SymbolId[]) => Promise<SymbolVisibilityRow[]>;

  /**
   * Each requested file's persisted symbol ranges (bd tea-rags-mcp-9i2ow) — the
   * `persisted` range source the payload heal settles chunks against, where the
   * deferred chunk pass uses the walk instead. Every ranged row comes back, and
   * rows with a NULL range (written before migration 024) are COUNTED, so "rows
   * the owner rule cannot place" stays distinguishable from "no rows"; a path
   * with no row at all is absent (bd tea-rags-mcp-39xca.2). Empty input is a
   * no-op.
   *
   * Callers bound the set themselves — one call is one IPC frame on the daemon.
   */
  getSymbolLineRangesBulk: (relPaths: readonly RelPath[]) => Promise<Map<RelPath, PersistedSymbolLineRanges>>;

  // ── Identifier declarations (naming lexicon, bd tea-rags-mcp-4p3sb.8) ──

  /**
   * Make `cg_identifiers` EQUAL each entry's rows for every file the entries
   * name, in one transaction; last-wins per relPath, and an entry with no rows
   * clears its file. A file no entry names is untouched. Empty entries is a
   * no-op.
   */
  replaceIdentifiersBulk: (entries: readonly IdentifierReplaceEntry[]) => Promise<void>;

  /**
   * Make `cg_type_declarations` EQUAL each entry's rows for every file the
   * entries name, in one transaction — the {@link replaceIdentifiersBulk}
   * contract over the naming lexicon's type table (bd tea-rags-mcp-vi0wx).
   */
  replaceTypeDeclarationsBulk: (entries: readonly TypeDeclarationReplaceEntry[]) => Promise<void>;

  /**
   * Rows whose EFFECTIVE type is in `q.types`, grouped by (type, kind, name,
   * typeSource) and counted. The effective type of an untyped row bound to a
   * call is its callee's `return` type when the call has exactly one `exact`
   * edge — reported as `typeSource: "call-return"`. Empty `types` reads nothing.
   */
  aggregateIdentifiersByType: (q: IdentifierTypeAggregateQuery) => Promise<IdentifierTypeAggregateRow[]>;

  /**
   * Rows bound to one of `q.callees`, grouped by (member, receiver, kind, name)
   * and counted — typed or not. Empty `callees` reads nothing.
   */
  aggregateIdentifiersByCallee: (q: IdentifierCalleeScopeQuery) => Promise<IdentifierCalleeAggregateRow[]>;

  /** The typed `param` and `return` rows of the given owner symbols. */
  anchorIdentifierTypes: (symbolIds: readonly SymbolId[]) => Promise<AnchorIdentifierTypeRow[]>;

  /**
   * Homonymy: per name, which effective types it is bound to and how often (`null` = untyped);
   * `excludePaths` files unread, `languages` scoped as {@link IdentifierLanguageScope}.
   */
  identifierNameTypes: (
    names: readonly string[],
    excludePaths?: readonly string[],
    languages?: readonly string[],
  ) => Promise<IdentifierNameTypeRow[]>;

  /**
   * Collision: the given names that are already a `cg_symbols.short_name` outside the `excludePaths`
   * files, in files of `languages` ({@link IdentifierLanguageScope}: absent = every language).
   */
  existingSymbolShortNames: (
    names: readonly string[],
    excludePaths?: readonly string[],
    languages?: readonly string[],
  ) => Promise<string[]>;

  /**
   * Head words of production method / function names opening at least
   * `q.minTails` noun tails, with how often each opens and ends a name — one
   * row per head (per head and file language under `groupByLanguage`, where
   * `minTails` applies per language), largest first. Aggregated in SQL — the
   * method table never reaches the caller.
   */
  readMethodHeadWords: (q: MethodHeadWordQuery) => Promise<MethodHeadWordRow[]>;

  /**
   * Holders per (noun tail, head of `q.heads`) for the tails two or more of
   * those heads open across the read — contested tails only, so the answer is
   * bounded by the conflicts, not by the method table.
   */
  readMethodTailVerbs: (q: MethodTailVerbQuery) => Promise<MethodTailVerbRow[]>;

  /** Production method / function names matching any of `q.patterns`, with their holders, largest first. */
  readMethodNamesMatching: (q: MethodNamePatternQuery) => Promise<MethodNameRow[]>;

  /** Row count behind {@link aggregateIdentifiersByType} for the same scope — drives scope widening. */
  countIdentifiers: (q: IdentifierTypeScopeQuery) => Promise<number>;

  /**
   * Rows named one of `q.names` in scope, grouped by (name, kind, effective
   * type) and counted — untyped rows included (`typeName: null`). The effective
   * type is the one {@link aggregateIdentifiersByType} reports. Empty `names`
   * reads nothing.
   */
  aggregateIdentifiersByName: (q: IdentifierNameScopeQuery) => Promise<IdentifierNameKindTypeRow[]>;

  /** Row count in scope per file language, largest first; empty when the scope holds no rows. */
  identifierLanguageCounts: (q: IdentifierLanguageCountQuery) => Promise<IdentifierLanguageCountRow[]>;

  /**
   * A reservoir sample of at most `q.limit` scoped rows that carry a persisted
   * type or a bound callee, grouped and counted. Persisted types only — no
   * call-return join: the sample measures how the project names what it binds.
   */
  sampleIdentifierShapes: (q: IdentifierShapeSampleQuery) => Promise<IdentifierShapeSampleRow[]>;

  /**
   * Phase 1 of the project-wide naming ontology audit (bd tea-rags-mcp-4p3sb.20):
   * whole-table totals and every generic-name CANDIDATE of the scope with its
   * types, for the caller to judge. Throws when `cg_identifiers` does not exist.
   */
  readOntologyReportSummary: (q: OntologyReportQuery) => Promise<OntologyReportSummaryRows>;

  /**
   * Phase 2 of the audit: every requested section aggregated in DuckDB, one
   * query per section, each item with its counts and one example row, over the
   * scope's concept rows minus every row named in `excludedGenericNames` — the
   * caller's JUDGED generic names, so the sections and the summary agree on
   * which names are generic. See {@link OntologyReportQuery} for what counts as
   * evidence. Throws when `cg_identifiers` does not exist.
   */
  readOntologyReportSections: (
    q: OntologyReportQuery,
    excludedGenericNames: readonly string[],
  ) => Promise<OntologyReportSectionRows>;

  /**
   * The type-level symbols of the scope with their inheritance ancestors, for
   * type-role derivation (bd tea-rags-mcp-vi0wx). Rows of unknown kind, the
   * `excludePaths` files and non-production paths are never read. Ordered by
   * `rel_path`, then declaration line, then `symbol_id`: within a file the rows
   * arrive in declaration order, which the primary-type pick relies on.
   */
  readTypeNameRows: (q: TypeNameQuery) => Promise<TypeNameRow[]>;

  // ── Tier 2 graph metrics (Slice 2 / B1) ──

  /**
   * Count of distinct files that transitively depend on `relPath` via
   * import edges (reverse BFS). Bounded by `maxDepth` to keep cost
   * predictable on large repos — depth 1 = direct fanIn, depth 5
   * (default) captures most realistic blast radii.
   */
  getTransitiveImpact: (relPath: RelPath, maxDepth?: number) => Promise<number>;

  /**
   * Setwise read of `{ fanIn, fanOut, transitiveImpact }` for a SET of roots —
   * the batched replacement for the `3 × fileCount` per-file getter loop in the
   * finalize overlay read-back (bd tea-rags-mcp-6aytq). Three statements per
   * call regardless of set size: two GROUP-BYs and ONE recursive CTE that seeds
   * every root at once and carries the root through the recursion, so each
   * root's count is its own — never shared with an overlapping blast radius.
   *
   * Values are identical to the per-file getters at the same `maxDepth`, and a
   * root with no rows in either direction is ABSENT from the map (the caller's
   * `?? 0` matches the getters, which return 0 on no rows). Empty input is a
   * no-op returning an empty map.
   *
   * Callers bound the set themselves — one call becomes one IPC frame and one
   * live CTE intermediate, both of which grow with the request.
   */
  getFileMetricsBulk: (relPaths: readonly RelPath[], maxDepth?: number) => Promise<Map<RelPath, FileGraphMetrics>>;

  // ── Cycle detection (Slice 2 / B2) ──

  /**
   * Read the persisted cycles table. Each `CycleEntry` is one
   * strongly-connected component of length >= 2 (single-node "cycles"
   * are excluded — they're either harmless or surfaced by other
   * signals). Sub-millisecond read for the MCP `find_cycles` tool.
   *
   * When `pathPattern` (a picomatch glob) is given, a cycle is kept iff
   * AT LEAST ONE member resolves to a matching file path. Cross-boundary
   * cycles (one member inside the scope, one outside) are retained.
   */
  findCycles: (scope: CycleScope, pathPattern?: string) => Promise<CycleEntry[]>;

  /**
   * Read the adjacency (source -> target[]) for `scope` from the
   * appropriate edge table. Domain orchestrators (codegraph provider,
   * metrics service) consume this to run Tarjan / PageRank without
   * the adapter knowing about either algorithm — keeps the adapter
   * layer pure CRUD.
   *
   * Prefer `streamAdjacency` for new callers — it lets the consumer
   * build a compact id-keyed representation without the adapter
   * pre-bucketing into `Map<string, string[]>`.
   */
  listAdjacency: (scope: CycleScope) => Promise<Map<string, string[]>>;

  /**
   * The persisted file dependency graph, whole: every walked file with its
   * symbol count, and every `cg_symbols_edges_file` row with the resolved call
   * weight across it. The boundary diagnostics judge it
   * (`get_architecture_report`, bd tea-rags-mcp-94hd9); no filter here, because
   * an edge to an unwalked file still moves its source's instability.
   */
  readFileDependencyGraph: () => Promise<FileDependencyGraph>;

  /**
   * Resolved method edges whose target is declared `private` / `protected` or
   * named with a leading underscore, restricted to targets declared in a file
   * of one of `languages` — the candidate set the convention-privacy check of
   * `get_architecture_report` judges (bd tea-rags-mcp-r8hme.1). An empty
   * `languages` reads nothing.
   */
  readNonPublicMemberEdges: (languages: readonly string[]) => Promise<NonPublicMemberEdge[]>;

  // ── Temporal co-change sub-graph (bd tea-rags-mcp-x4rpp) ──

  /**
   * Replace `cg_temporal_files` / `cg_temporal_edges_cochange` /
   * `cg_temporal_meta` with one build, atomically. Wholesale: nothing of the
   * previous build survives.
   */
  replaceTemporalCochange: (snapshot: TemporalCochangeSnapshot) => Promise<void>;

  /** Provenance of the persisted co-change build; `null` before the first one. */
  readTemporalCochangeMeta: () => Promise<TemporalCochangeBuildMeta | null>;

  /**
   * Every persisted co-change pair, flagged with whether a file edge or a
   * resolved method edge joins its endpoints in either direction — the input of
   * the silent-coupling detector (`get_architecture_report`, bd
   * tea-rags-mcp-b4dcz).
   */
  readTemporalCochangeGraph: () => Promise<TemporalCochangeGraph>;

  // ── Temporal symbol-commit store (bd tea-rags-mcp-3gz4f) ──

  /** Replace each named file's symbol-commit rows; files not named stand. */
  replaceTemporalSymbolCommits: (files: TemporalSymbolCommitFileSnapshot[]) => Promise<void>;

  /** Every file holding symbol-commit rows, sorted — the universe the flush hook prunes against. */
  storedTemporalSymbolCommitFilePaths: () => Promise<string[]>;

  /** Drop every symbol-commit row of the named files. */
  deleteTemporalSymbolCommitFiles: (relPaths: string[]) => Promise<void>;

  /** One file's symbol-commit rows, `commitShas` parsed. */
  readTemporalSymbolCommits: (relPath: RelPath) => Promise<TemporalSymbolCommitFileSnapshot>;

  // ── Per-review working-tree file edges (bd tea-rags-mcp-89k7k.1.2) ──
  //
  // One throwaway `cg_review_file_edges_<reviewId>` table per review — the
  // review id embeds its epoch, so the age sweep reads it off the NAME.
  // Deliberately outside the migration catalog: the DDL is issued at runtime
  // and the table is dropped the moment the review ends.

  /**
   * Create this review's table when absent and APPEND the edges to it, in one
   * transaction. An empty `edges` still creates the table, so "review with no
   * edges" stays distinguishable from "review never written". Reviews write
   * once; a second put to the same id appends — the retry contract, never a
   * replace.
   */
  putReviewFileEdges: (reviewId: string, edges: readonly ReviewFileEdge[]) => Promise<void>;

  /** Drop this review's table. Idempotent — a table already gone is fine. */
  dropReviewFileEdges: (reviewId: string) => Promise<void>;

  /**
   * Drop every `cg_review_file_edges_*` table whose embedded epoch is at least
   * `maxAgeSeconds` behind `nowEpochSeconds`, plus every malformed-named one —
   * a crashed process's tables die on the next review anywhere. Returns the
   * dropped table names.
   */
  sweepExpiredReviewFileEdges: (nowEpochSeconds: number, maxAgeSeconds: number) => Promise<string[]>;

  /**
   * This review's edges ordered by (source_rel_path, target_rel_path). A table
   * that does not exist reads as no edges — never a throw.
   */
  readReviewFileEdges: (reviewId: string) => Promise<ReviewFileEdge[]>;

  /**
   * The `cg_symbols_edges_file` rows whose TARGET is `relPath` — the files
   * importing it — each weighted like {@link readFileDependencyGraph}'s edges.
   * File-scope `get_callers` reads it (bd tea-rags-mcp-gfvr8).
   */
  getFileImporters: (relPath: RelPath) => Promise<FileImportLookup>;

  /**
   * The `cg_symbols_edges_file` rows whose SOURCE is `relPath` — the files it
   * imports. File-scope `get_callees` reads it (bd tea-rags-mcp-gfvr8).
   */
  getFileImports: (relPath: RelPath) => Promise<FileImportLookup>;

  /**
   * Stream the adjacency for `scope` one `[source, target]` pair at a
   * time. Slice 2 hot-path replacement for `listAdjacency` — gives the
   * domain layer freedom to bucket into a compact id-keyed structure
   * (e.g. `Map<number, number[]>` with a separate id-table) instead of
   * paying the string-keyed `Map<string, string[]>` overhead twice.
   *
   * Vertices are relPaths in the file scope and `FileScopedSymbolId`s
   * (`fileScopedSymbolKey`) in the method scope — never bare symbolIds, which
   * name every namesake at once (bd tea-rags-mcp-4g9ga). `listAdjacency`
   * uses the same identity.
   *
   * Method scope also yields the per-edge dispatch confidence as an
   * optional third element (bd tea-rags-mcp-s5ato; legacy NULL rows
   * coalesce to 1.0) so PageRank can weight dynamic/cone fan-out edges.
   * File edges carry no confidence — consumers default a missing weight
   * to 1.
   */
  streamAdjacency: (scope: CycleScope) => AsyncIterableIterator<[source: string, target: string, weight?: number]>;

  /**
   * Flush the WAL to the main database file. Slice 2 streaming
   * pass-2 issues this every N files so the WAL does not grow
   * unbounded during a long indexing pass. Idempotent — a no-op
   * checkpoint when the WAL is empty is cheap.
   */
  checkpoint: () => Promise<void>;

  /**
   * Rewrite the store without the dead row versions it keeps, when enough of
   * it is dead to be worth the cost (bd tea-rags-mcp-dvzdm). The call is safe
   * to issue after every run: below the threshold it only measures.
   *
   * Concurrent calls on the same store wait for it rather than fail, and the
   * client stays usable afterwards. A failure leaves the previous store intact
   * and is reported as a typed error; nothing is lost by retrying on a later run.
   */
  compactStorage: () => Promise<CodegraphStorageCompactionOutcome>;

  /**
   * Atomically replace the cycles table for `scope` with the supplied
   * SCC list. Domain runs Tarjan; adapter persists the result.
   * Each inner array is one SCC's members in walk order; cycle_id is
   * assigned by the adapter using the array index. Single-node SCCs
   * are caller-filtered. Method-scope members are the vertex ids
   * `streamAdjacency` yields (`FileScopedSymbolId`); the adapter splits
   * them back into the member's file and symbolId.
   */
  replaceCycles: (scope: CycleScope, sccs: readonly (readonly string[])[]) => Promise<void>;

  // ── Tier 3 graph metric (Slice 2 / B3) ──

  /**
   * Atomically replace the per-symbol PageRank table with the supplied
   * ranks, keyed by the method-scope vertex ids `streamAdjacency` yields.
   * Domain runs the iterative algorithm; adapter persists.
   * Empty input wipes the table — useful after a force-reindex when
   * the method graph is fully rebuilt.
   */
  replacePageRanks: (ranks: ReadonlyMap<string, number>) => Promise<void>;

  /**
   * Look up the PageRank of a single declaration. Ranks are keyed by
   * `(relPath, symbolId)` (bd tea-rags-mcp-4g9ga): with `relPath` the rank of
   * that file's declaration; without it the bare id is ambiguous across
   * namesakes and the highest rank among them is returned. Returns 0 when the
   * symbol is unknown or the metrics table hasn't been populated yet — both
   * cases are treated as "rank-irrelevant".
   */
  getPageRank: (symbolId: SymbolId, relPath?: RelPath) => Promise<number>;

  /**
   * Symbols and files whose derived signals (`fanIn` / `fanOut` / `pageRank`,
   * and per-file `fanIn` / `fanOut`) differ from the baseline recorded by the
   * last successful payload heal — bd tea-rags-mcp-a2ddb.
   *
   * Read AFTER the metrics recompute and BEFORE {@link refreshSymbolSignalsPrev},
   * which is the only ordering in which it means anything. A row absent from the
   * baseline counts as moved, so the first run after migration 023 names every
   * symbol and every file exactly once.
   *
   * The signals it compares are the ones the payload is actually built from —
   * the confidence-weighted symbol fan of {@link getChunkSignalsBulk} and the
   * per-path edge counts of {@link getFileMetricsBulk} — NOT raw edge counts.
   * `transitiveImpact` and `isHub` are outside the comparison: the first would
   * need a whole-corpus reverse BFS to diff, the second moves for every file at
   * once whenever the collection p95 does.
   */
  diffSymbolSignals: () => Promise<CodegraphSignalDrift>;

  /**
   * Replace the previous-run signal baseline with the current graph, both
   * tables in one transaction.
   *
   * Called by the coordinator AFTER the heal succeeded, never by the finalizer.
   * Refreshing it before the payload is rewritten would erase the very diff a
   * failed heal must retry, and the drift would then stay invisible until the
   * file changed again — which is the defect this whole mechanism exists to fix.
   */
  refreshSymbolSignalsPrev: () => Promise<void>;

  /**
   * Run Tarjan SCC over both scopes + PageRank over the method graph and
   * persist the results, all in one round-trip. Optional because only the
   * daemon-routed client (`DaemonGraphDbClient`) implements it — the
   * in-process `DuckDbGraphClient` leaves it undefined so the provider's
   * direct-mode path runs the analysis inline (one streamAdjacency pass per
   * scope). When present, the provider delegates the whole 30 GB graph build
   * to the single daemon process instead of every MCP client.
   */
  computeAndPersistCyclesAndSignals?: () => Promise<void>;
}
