/**
 * Per-run state of the codegraph symbols provider (bd tea-rags-mcp-6vfrj / G2).
 *
 * Pass-1 (`sink.write`) merges each file's extraction aggregates into the
 * run-global maps held here; the pass-1→pass-2 barrier seals them (hierarchy
 * view, reverse include-by index, self-dispatch templates); pass-2
 * (`CallEdgeResolutionRunner`) reads them for every `CallContext` and tallies
 * resolve outcomes back into `stats`.
 *
 * Extracted from `CodegraphEnrichmentProvider` so ONE object owns the lifecycle
 * of these fields. The provider previously spread the reset logic across four
 * seams that cleared overlapping but non-identical sets; those seams are
 * preserved verbatim as named methods here (`resetTally` / `clearForNextRun` /
 * `clearAll`) rather than unified — unification is a behavior change and needs
 * its own TDD cycle.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ClassFieldParamLink,
  DispatchTableDef,
  FileExtraction,
  GlobalSymbolTable,
  HierarchyView,
  InheritanceEdgeRow,
  KnownTargetCallArgs,
  RelPath,
  ResolveRunStatsRow,
  SymbolDefinition,
} from "../../../../contracts/types/codegraph.js";
import type { RubyTypeRef, SchemaColumnAccessorSource } from "../../../../contracts/types/language.js";
import type { ProviderRunMetrics } from "../../../../contracts/types/provider.js";
import { isDebug } from "../../../../infra/runtime.js";
import { MapHierarchyView } from "../hierarchy-view.js";
import {
  deriveClassFieldTypesFromParams,
  foldKnownTargetParamTypes,
  type KnownTargetParamTypes,
} from "./call-arg-param-types.js";
import { buildHierarchySnapshot } from "./inheritance-edges.js";
import { RECEIVER_KINDS, type ReceiverKind } from "./receiver-kind.js";
import { collectSchemaColumnModels, synthesizeSchemaColumnDefs } from "./schema-column-synthesis.js";
import {
  buildSelfDispatchProbe,
  collectSelfInstantiatingClassMethods,
  deriveServiceEntryReturnTypes,
  discoverSelfDispatchTemplates,
  foldSelfDispatchTemplates,
  type SelfDispatchMethod,
} from "./self-dispatch-discovery.js";

export interface ReceiverKindTally {
  attempted: number;
  resolved: number;
  // tea-rags-mcp-ykj7 — unresolved-but-external calls in this bucket (subset of
  // attempted − resolved). Persisted to cg_run_stats.external_skipped.
  externalSkipped: number;
  // bd cai0 — unresolved-but-statically-undeterminable calls in this bucket
  // (dynamic send(var)). Persisted to cg_run_stats.unresolvable.
  unresolvable: number;
  // Unresolved calls in this bucket whose member has NO in-project definition
  // (gem/core/runtime-generated/dynamic). Excluded from the inProjectEdgeRecall
  // denominator. Persisted to cg_run_stats.no_in_project_def.
  noInProjectDef: number;
  // bd tea-rags-mcp-83cl7 — unresolved calls in this bucket whose member is a
  // CORE/runtime name on an UNTYPED receiver, where a project homonym def
  // defeats the noInProjectDef gate. Excluded from the inProjectEdgeRecall
  // denominator. Persisted to cg_run_stats.core_ambiguous.
  coreAmbiguous: number;
  // bd f2jsb/j0pki — unresolved-but-over-cap-ambiguous dispatch fan-outs in
  // this bucket (subset of attempted − resolved). Its own bucket: NOT a genuine
  // miss, NOT external. Persisted to cg_run_stats.ambiguous_fanout.
  ambiguousFanout: number;
}

export interface RunStats {
  extractedFiles: number;
  fileEdgeCount: number;
  methodEdgeCount: number;
  callsAttempted: number;
  callsResolved: number;
  // tea-rags-mcp-ykj7 — unresolved calls the language resolver flagged as
  // targeting an external library / runtime import (`Math.max`, `fs.readFile`,
  // `Net::HTTP.get`). Excluded from the resolveSuccessRate denominator so the
  // rate reflects PROJECT-INTERNAL resolver capability, not unresolvable
  // external-library noise. Subset of (callsAttempted − callsResolved).
  callsExternalSkipped: number;
  // bd cai0 — unresolved calls flagged by the walker as dynamic send(var) with a
  // non-literal target: statically undeterminable, not a resolver miss. Excluded
  // from the resolveSuccessRate denominator. Subset of (callsAttempted −
  // callsResolved − callsExternalSkipped).
  callsUnresolvable: number;
  // Genuine-miss calls whose member short-name has NO in-project definition
  // (symbolTable.lookupByShortName empty) — gem/core/runtime-generated/dynamic
  // targets that can never produce an in-project edge. Excluded from the
  // inProjectEdgeRecall denominator so recall measures graph completeness over
  // calls that COULD resolve to a project symbol. Subset of the genuine-miss
  // bucket (callsAttempted − callsResolved − callsExternalSkipped −
  // callsUnresolvable).
  callsNoInProjectDef: number;
  // bd tea-rags-mcp-83cl7 — genuine-miss calls whose member IS defined in the
  // project but is a CORE/runtime name (`each`, `to_s`, `first`) reached through
  // an UNTYPED receiver: the real callee is the runtime and the project def is a
  // same-name coincidence. On taxdome this phantom was 4391 of 20964 recorded
  // recall holes. Excluded from the inProjectEdgeRecall / resolveSuccessRate
  // denominators exactly like callsNoInProjectDef. Subset of the residual
  // genuine-miss bucket (callsAttempted − callsResolved − callsExternalSkipped −
  // callsUnresolvable − callsNoInProjectDef).
  callsCoreAmbiguous: number;
  // bd f2jsb/j0pki — subset of (callsAttempted − callsResolved) that the
  // dispatch kernel judged over-cap AMBIGUOUS (survivors > corpus-adaptive
  // fan-out cap) and recorded as a cg_ambiguous_fanout aggregate instead of m
  // edges. Its own bucket: NOT a genuine miss, NOT external — strict recall
  // keeps it in the denominator, coveredRecall counts it as coverage.
  callsAmbiguousFanout: number;
  // Per-(code language, receiver kind) resolve breakdown (bd tea-rags-mcp-cnqrg,
  // extends j431). Source of truth: the aggregate scalars above, the per-kind
  // summary (getRunMetrics, j431 view) and the per-language summary
  // (get_index_status) all derive from this by summing across the other axis.
  // recordRunStats persists each (language, kind) cell to cg_run_stats so the
  // daemon-readable proxy can break resolveSuccessRate down per language and
  // locate the resolver gap. Lazily grows one entry per language observed in
  // this run. Test files never reach here — the codegraph exclusion filter
  // drops them upstream at extraction, unconditionally.
  byLanguageKind: Map<string, Record<ReceiverKind, ReceiverKindTally>>;
}

export function emptyReceiverKindTally(): Record<ReceiverKind, ReceiverKindTally> {
  const out = {} as Record<ReceiverKind, ReceiverKindTally>;
  for (const kind of RECEIVER_KINDS) {
    out[kind] = {
      attempted: 0,
      resolved: 0,
      externalSkipped: 0,
      unresolvable: 0,
      noInProjectDef: 0,
      coreAmbiguous: 0,
      ambiguousFanout: 0,
    };
  }
  return out;
}

/** Lazily fetch this language's per-kind tally, creating a zeroed one on first sight. */
export function languageKindTally(stats: RunStats, language: string): Record<ReceiverKind, ReceiverKindTally> {
  let kinds = stats.byLanguageKind.get(language);
  if (!kinds) {
    kinds = emptyReceiverKindTally();
    stats.byLanguageKind.set(language, kinds);
  }
  return kinds;
}

/**
 * Project the per-(language, kind) tally onto the per-receiver-kind axis by
 * summing across languages — the j431 view consumed by getRunMetrics.
 */
export function aggregateReceiverKinds(stats: RunStats): Record<ReceiverKind, ReceiverKindTally> {
  const out = emptyReceiverKindTally();
  for (const kinds of stats.byLanguageKind.values()) {
    for (const kind of RECEIVER_KINDS) {
      out[kind].attempted += kinds[kind].attempted;
      out[kind].resolved += kinds[kind].resolved;
      out[kind].externalSkipped += kinds[kind].externalSkipped;
      out[kind].unresolvable += kinds[kind].unresolvable;
      out[kind].noInProjectDef += kinds[kind].noInProjectDef;
      out[kind].coreAmbiguous += kinds[kind].coreAmbiguous;
      out[kind].ambiguousFanout += kinds[kind].ambiguousFanout;
    }
  }
  return out;
}

export function createEmptyRunStats(): RunStats {
  return {
    extractedFiles: 0,
    fileEdgeCount: 0,
    methodEdgeCount: 0,
    callsAttempted: 0,
    callsResolved: 0,
    callsExternalSkipped: 0,
    callsUnresolvable: 0,
    callsNoInProjectDef: 0,
    callsCoreAmbiguous: 0,
    callsAmbiguousFanout: 0,
    byLanguageKind: new Map(),
  };
}

/**
 * Reverse include-by index (bd cai0/2oky5): invert the run-global ancestor maps
 * so `out[X]` lists every class that has X as a direct ancestor (via superclass,
 * include, or prepend). Language-agnostic — pure data inversion. Consumed by the
 * Ruby `super` module-method fallback to find the classes whose MRO a super call
 * inside module X dispatches through.
 *
 * Lives here rather than in `provider.ts` so `run-state.ts` does not import its
 * own consumer (that edge would reintroduce the kind of module cycle G3 broke).
 * `provider.ts` re-exports it for import stability.
 */
export function buildIncludedBy(
  ancestors: Record<string, readonly string[]>,
  prepended: Record<string, readonly string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (child: string, ancestor: string): void => {
    const list = (out[ancestor] ??= []);
    if (!list.includes(child)) list.push(child);
  };
  for (const [child, list] of Object.entries(ancestors)) {
    for (const a of list) add(child, a);
  }
  for (const [child, list] of Object.entries(prepended)) {
    for (const a of list) add(child, a);
  }
  return out;
}

/**
 * The run-global maps whose NON-EMPTINESS pass-2 tests per file, to decide
 * between the run-global fact and the calling file's own (bd
 * tea-rags-mcp-8zwl9).
 *
 * `instantiatedTypes` is deliberately absent: it is a `Set`, so `.size` already
 * answers in constant time. These six are plain objects, where the same
 * question cost a full `Object.keys` array of a map that grows across the whole
 * run.
 */
export type RunGlobalMapName =
  | "ancestors"
  | "prependedAncestors"
  | "classExtends"
  | "returnTypes"
  | "ivarTypes"
  | "structuredReturnTypes";

const RUN_GLOBAL_MAP_NAMES: readonly RunGlobalMapName[] = [
  "ancestors",
  "prependedAncestors",
  "classExtends",
  "returnTypes",
  "ivarTypes",
  "structuredReturnTypes",
];

export class CodegraphRunState {
  /**
   * Persisted-schema column vocabularies contributed by the registered
   * languages (bd tea-rags-mcp-8l5fo). Collected ONCE by the provider's
   * constructor (through the same `languageFactory` seam as the exclusion
   * filter, because `factory.create` is expensive) and injected here. Empty
   * (default — no factory / no language declares one) ⇒ the schema pre-pass
   * never runs.
   */
  constructor(private readonly schemaColumnSources: readonly SchemaColumnAccessorSource[] = []) {}

  /**
   * Per-run counters surfaced via `getRunMetrics()`. Read-and-cleared by
   * `CompletionRunner` at end of each enrichment cycle. Tracked here
   * (not in the sink) so they survive across multiple sink.write/finish
   * pairs within a single run (e.g. backfill paths).
   */
  stats: RunStats = createEmptyRunStats();

  /**
   * Files pass-1 absorbed, per language — the volume pass-2 is about to
   * resolve, known BEFORE it starts (bd tea-rags-mcp-6aytq).
   *
   * Every file that reaches `absorb` is spilled in the same breath, so this
   * count IS the pass-2 file count, and it is a fact rather than a projection:
   * a force-resolve re-extracts the whole project, an incremental run carries
   * the handful of files that changed, and the number says which happened
   * without anything having to consult the repair set. `prepareResolvePass`
   * hands each language its own figure so a resolver can prime run-scoped
   * caches whose cost only a bulk pass repays.
   *
   * Per LANGUAGE, not a single total: a run of 10,000 Ruby files and 40
   * TypeScript ones is not a bulk pass for TypeScript.
   */
  readonly extractedFilesByLanguage = new Map<string, number>();

  /**
   * The same files, listed rather than counted (bd tea-rags-mcp-6aytq).
   *
   * Kept beside the counter rather than replacing it because they are read by
   * different decisions: `prepareResolvePass` measures the COUNT against a
   * bulk-pass threshold, while a resolver that primes builds its cache over the
   * LIST. TypeScript is the consumer — its whole-project `ts.Program` is rooted
   * at the tsconfig's include/exclude expansion, which on taxdome misses 936 of
   * the 10,912 files the run resolves, and each miss costs a per-entry
   * `ts.createProgram`.
   *
   * The retained cost is a path string per extracted file — ~1 MB for a
   * 10,000-file TypeScript corpus, released with the rest of the run state at
   * both clear seams.
   */
  readonly extractedRelPathsByLanguage = new Map<string, RelPath[]>();

  /**
   * Per-file SHA256 for the run, threaded in from `FileSignalOptions`
   * (bd tea-rags-mcp-6goqa). The graph finalizer stamps each written file row
   * with its hash so a later run can tell a row that is CURRENT from one that
   * merely EXISTS. Undefined for direct/test callers, which persists NULL and
   * makes the file re-extract rather than be assumed current.
   */
  contentHashes?: ReadonlyMap<string, string>;

  /**
   * Per-run aggregation of `FileExtraction.classAncestors` across every
   * file walked in pass-1. The resolver needs ancestors keyed by
   * `targetType` (the class a variable is bound to) — that target type's
   * declaration usually lives in a DIFFERENT file than the caller, so
   * per-file ancestor maps are insufficient. Reset on finish().
   */
  ancestors: Record<string, readonly string[]> = {};

  /**
   * Per-run set of FQs declared COMPACT (`class A::B::C`), aggregated from
   * `FileExtraction.compactDeclaredClasses`. Passed to the resolver ctx so
   * `canonicalizeAncestorFq` skips the nesting prefix-walk for them (bd
   * lawlq.3.7). Reset on finish() alongside ancestors.
   */
  compactClasses = new Set<string>();

  /**
   * Per-run aggregation of `FileExtraction.classPrependedAncestors`
   * (bd tea-rags-mcp-3jvn). Same lifecycle as `ancestors` — merged
   * across pass-1 files, consumed by pass-2 resolver. Walked BEFORE the
   * bound class itself by `RubyCallResolver.resolveByLocalTypeInternal`
   * so prepended modules' methods shadow the class's own.
   */
  prependedAncestors: Record<string, readonly string[]> = {};

  /**
   * Reverse include-by index (`buildIncludedBy`) computed ONCE from the frozen
   * run-global ancestor + prepended maps at the pass-1→pass-2 barrier, instead of
   * rebuilding the same inversion per file inside `resolveExtraction`
   * (24583× on taxdome — pure waste, `buildIncludedBy` has an inner O(n²) scan).
   * Pass-2 reads it only when BOTH resolver ancestor inputs ARE the run-global
   * maps; the per-file fallback (single-file / test mode) still computes fresh.
   */
  includedBy: Record<string, string[]> = {};

  /**
   * Per-run aggregation of `FileExtraction.classExtends`
   * (bd tea-rags-mcp-d29r). Single-inheritance parent map merged across
   * pass-1 files so the resolver's `super()` branch can route to the
   * parent class regardless of which file declares it.
   */
  classExtends: Record<string, string> = {};

  /**
   * Per-run aggregation of `FileExtraction.classSchemaTables`
   * (bd tea-rags-mcp-8l5fo): `class FQ → explicit ORM table override`. Read ONCE
   * at the pass-1→pass-2 barrier by the schema-column pre-pass, where it decides
   * which model owns each `db/schema.rb` table. Same lifecycle as `classExtends`.
   */
  schemaTables: Record<string, string> = {};

  /**
   * Raw contents of the project's persisted-schema snapshot for the CURRENT run,
   * keyed by the declaring language's `schemaRelPath`. Read ONCE per run from the
   * project root by {@link loadSchemaSnapshots} — the same one-manifest-read
   * shape as `gemfileContent` — because the barrier (`seal`) has no `root` of
   * its own. bd tea-rags-mcp-8l5fo.
   */
  schemaSnapshots: Record<string, string> = {};
  private schemaSnapshotsLoaded = false;

  /**
   * Per-run aggregation of `FileExtraction.functionReturnTypes`
   * (bd tea-rags-mcp-6g9c). `functionName → declaredReturnTypeName` merged
   * across pass-1 files so the Go resolver can bind `x := New(); x.method()`
   * to `<New's return type>#method` even when `New` is declared in a
   * different file. Same lifecycle as `classExtends` — reset on finish().
   */
  returnTypes: Record<string, string> = {};

  /**
   * Per-run aggregation of `FileExtraction.instantiatedTypes` (bd
   * tea-rags-mcp-pffv). The union of every instantiated fq const across pass-1
   * files, so `ConeDispatchResolver` can RTA-prune a CHA cone regardless of
   * which file does the `Klass.new`. Same lifecycle as `returnTypes` — reset
   * on finish / empty-run / release.
   */
  readonly instantiatedTypes = new Set<string>();

  /**
   * Per-run aggregation of `FileExtraction.ivarTypes` (Ruby type-source engine,
   * Increment 1, Task 1.5). `fqClassName → "@ivar" → typeName` merged across
   * pass-1 files so the resolver's PRECISE `@ivar.method()` path
   * (`ctx.ivarTypes`) sees a class's annotated ivars regardless of which file
   * declared the class. Same lifecycle as `returnTypes` — last-write-wins on
   * duplicate class keys, reset on finish / empty-run.
   *
   * Stays empty while no type source emits `kind:"ivar"` facts (bd
   * tea-rags-mcp-wr7ku) — an empty map here is expected, not a wiring defect.
   */
  ivarTypes: Record<string, Record<string, string>> = {};

  /**
   * Per-run aggregation of `FileExtraction.structuredReturnTypes` (Ruby
   * type-source engine, Increment 1, Task 1.5). `"<fqClass>#method" →
   * RubyTypeRef` merged across pass-1 files so the resolver's PRECISE
   * structured-return path (`ctx.structuredReturnTypes`) threads
   * `recv.method().member` chains to the richer ref (union / container
   * preserved) regardless of which file declared the method. Same lifecycle as
   * `returnTypes` — last-write-wins, reset on finish / empty-run.
   */
  structuredReturnTypes: Record<string, RubyTypeRef> = {};

  /**
   * Per-run aggregation of `FileExtraction.dispatchTables` keyed by table
   * NAME (bd tea-rags-mcp-n0zj). The value is a `DispatchTableDef[]` because
   * the same name may be declared in several files; the resolver
   * disambiguates by the caller's import map. Re-walking a file replaces its
   * own entry (dedup by relPath). Same lifecycle as `classExtends` —
   * reset on the empty-run path of `getRunMetrics`.
   */
  dispatchTables: Record<string, DispatchTableDef[]> = {};

  /**
   * Per-run aggregation of `FileExtraction.callbackParams` keyed by the
   * function/method symbolId (bd tea-rags-mcp-n0zj). Merged across pass-1
   * files so the resolver's bounded inter-procedural join sees a callee's
   * invoked param positions regardless of which file declared it.
   */
  callbackParams: Record<string, number[]> = {};

  /**
   * Per-run aggregation of normalized inheritance rows (bd tea-rags-mcp-o17v2).
   * Accumulated across pass-1 `sink.write` so the pass-1→pass-2 barrier can build
   * a complete `MapHierarchyView` BEFORE any file resolves. Inheritance edges are
   * persisted per-file DURING pass-2, so the DB is not yet complete when the
   * first file's CHA cone needs `getDescendants` — the in-memory snapshot closes
   * that gap. Same lifecycle as `classExtends` — reset on finish / empty-run.
   */
  inheritanceRows: InheritanceEdgeRow[] = [];

  /**
   * Bidirectional class-hierarchy view built from `inheritanceRows` at the
   * pass-1→pass-2 barrier (bd tea-rags-mcp-o17v2). Threaded into every resolve
   * `CallContext.hierarchy` so the CHA cone resolver can devirtualize a
   * polymorphic typed receiver to its overriding subtypes. `undefined` until the
   * barrier runs (and on reset) — the cone resolver treats absent as "no cone".
   */
  hierarchyView: HierarchyView | undefined;

  /**
   * Per-run accumulation of self-dispatch method candidates (DEFECT 2 —
   * self-receiver abstract-hook dispatch). One LIGHT record per method that
   * self-calls (`symbolId` + enclosing type + bare hook names), NOT the chunks,
   * so the NDJSON-spill heap optimisation holds. Fed to
   * `discoverSelfDispatchTemplates` at the pass-1→pass-2 barrier. Populated for
   * Ruby files only (the entry strategy that consumes the map is Ruby). Reset
   * alongside `inheritanceRows`.
   */
  selfDispatchMethods: SelfDispatchMethod[] = [];

  /**
   * Run-global `templateMethodSymbolId → abstractHookMember` map (DEFECT 2) built
   * from `selfDispatchMethods` at the barrier and threaded into every resolve
   * `CallContext.selfDispatchTemplates`. Empty until the barrier runs (and on
   * reset) — the Ruby entry strategy CONTINUEs when it is absent/empty. Reset
   * alongside `hierarchyView`.
   */
  selfDispatchTemplates: Record<string, string> = {};

  /**
   * Run-global list of self-instantiating CLASS-method symbolIds (DEFECT 2 v2)
   * built from `selfDispatchMethods` at the barrier and threaded into every
   * resolve `CallContext.selfInstantiatingClassMethods`. The Ruby entry strategy's
   * v2 branch reads it to bridge a class entry to the same-named instance template
   * (`self.call → new.call` service idiom). Empty until the barrier runs (and on
   * reset). Reset alongside `selfDispatchTemplates`.
   */
  selfInstantiatingClassMethods: string[] = [];

  /**
   * Per-run accumulation of known-target call-site argument types (bd
   * tea-rags-mcp-bvalc), DEDUPED by (targets, argTypes): a fold over agreement
   * is idempotent, so a thousand identical `Foo.new(bar)` sites contribute one
   * record while two DISAGREEING sites stay two and still conflict. Keeps the
   * pass-1 heap proportional to distinct call shapes rather than call sites.
   * Populated for Ruby files only; reset alongside `selfDispatchMethods`.
   */
  readonly knownTargetCallArgs = new Map<string, KnownTargetCallArgs>();

  /**
   * Per-run method-definition index `symbolId → positional param names` (bd
   * tea-rags-mcp-bvalc), from `ChunkExtraction.paramNames`. Maps an argument
   * POSITION to a parameter NAME at the barrier and, because it holds only real
   * definitions, gates which of a call site's constant-lookup candidates is the
   * actual callee.
   */
  paramNames: Record<string, readonly string[]> = {};

  /**
   * Per-run aggregation of `FileExtraction.classFieldParamLinks` (bd
   * tea-rags-mcp-bvalc): `fqClass → "@ivar" → (method, param)` for fields copied
   * verbatim from a parameter. Merged run-global because a class reopened across
   * files must present ONE link set to the barrier fold.
   */
  classFieldParamLinks: Record<string, Record<string, ClassFieldParamLink>> = {};

  /**
   * Coordinates (`"fqClass|@ivar"`) the walker typed on its own anywhere in the
   * run (bd tea-rags-mcp-bvalc). The derived-field fold skips these, so
   * inference and declaration always beat derivation — checked run-global
   * because the competing assignment may live in another file of a reopened
   * class. A key SET, not the map: only membership is ever asked.
   */
  readonly typedClassFields = new Set<string>();

  /**
   * Run-global `"<fqType>#<member>" → paramName → type`, folded at the barrier
   * from `knownTargetCallArgs` (bd tea-rags-mcp-bvalc). Seeded into each
   * method chunk's `localBindings` during pass-2. Empty until the barrier runs.
   */
  paramTypes: KnownTargetParamTypes = {};

  /**
   * Run-global `fqClass → "@ivar" → typeName` derived at the barrier by joining
   * `classFieldParamLinks` against `paramTypes` (bd tea-rags-mcp-bvalc).
   * Overlaid UNDER each file's own `classFieldTypes` in pass-2. Empty until the
   * barrier runs — an empty overlay leaves the channel byte-identical.
   */
  derivedClassFieldTypes: Record<string, Record<string, string>> = {};

  /**
   * Raw `Gemfile` contents for the CURRENT run, read ONCE from the project root
   * by {@link loadGemfile} and attached to every resolver `CallContext` so the
   * Ruby resolver gates DSL grammar to this project's gems (`catalogueForGemfile`).
   * Single-valued (not per-collection), same as `ancestors` — the provider
   * processes one collection per instance at a time. `undefined` ⇒ no Gemfile ⇒
   * FULL catalogue. `gemfileLoaded` guards the one-per-run read. Both reset
   * alongside `compactClasses` (bd tea-rags-mcp-adx5p.1).
   */
  gemfileContent: string | undefined = undefined;
  private gemfileLoaded = false;

  /**
   * Absolute root of the project being indexed by the CURRENT run, recorded by
   * {@link bindProjectRoot} at the same seams that read the Gemfile and the
   * schema snapshots, and attached to every resolver `CallContext`. Resolvers
   * whose answers depend on project-rooted state (TypeScript: `tsconfig.json`,
   * the file probe, the `ts.Program`) bind to it lazily on first use, because
   * the provider itself is constructed before any collection — and therefore
   * any project directory — is known. Same lifecycle as `gemfileContent`:
   * reset wherever that is reset.
   */
  projectRoot: string | undefined = undefined;

  /**
   * Has anything been written into each run-global map yet?
   *
   * Pass-2 asks this once per map per FILE, and the maps grow across the whole
   * run, so deriving it cost `Object.keys(map).length` — a full key array
   * allocated to answer a boolean, `files x maps x map-size` of pure waste. The
   * same shape was already found and fixed once in this mechanism for
   * `includedBy` (24583x on taxdome — see {@link includedBy}); these six are
   * that bug's remaining instances (bd tea-rags-mcp-8zwl9).
   *
   * Written ONLY by {@link markContributed} and {@link clearContributed}, and
   * read only by {@link hasRunGlobalEntries}, because an index's whole cost is
   * that it CAN disagree with the map it describes — the same reasoning that
   * keeps `rememberParse` / `forgetParse` paired in `TSProgramCache`.
   */
  private readonly contributedRunGlobals: Record<RunGlobalMapName, boolean> = {
    ancestors: false,
    prependedAncestors: false,
    classExtends: false,
    returnTypes: false,
    ivarTypes: false,
    structuredReturnTypes: false,
  };

  /**
   * Did any file — or any barrier fold — contribute to this run-global map?
   *
   * Equivalent to `Object.keys(this[name]).length > 0` and maintained to stay
   * so: {@link markContributed} fires per ENTRY WRITTEN, never on the mere
   * presence of an extraction field, so a file declaring `classAncestors: {}`
   * leaves the map unpopulated and this answer `false`.
   */
  hasRunGlobalEntries(name: RunGlobalMapName): boolean {
    return this.contributedRunGlobals[name];
  }

  /** Record that a map just received an entry. Call per write, not per field. */
  private markContributed(name: RunGlobalMapName): void {
    this.contributedRunGlobals[name] = true;
  }

  /**
   * Forget contributions for the maps a reset seam just emptied. Defaults to
   * all six; callers pass a subset because the seams clear overlapping but NOT
   * identical field sets — `drainMetrics`'s real-run branch keeps four of these
   * maps alive, and a flag cleared there would send pass-2 to the per-file
   * fallback while the run-global map still held facts.
   */
  private clearContributed(names: readonly RunGlobalMapName[] = RUN_GLOBAL_MAP_NAMES): void {
    for (const name of names) this.contributedRunGlobals[name] = false;
  }

  /**
   * Record the root this run indexes. Unguarded on purpose, unlike
   * {@link loadGemfile}: it reads nothing, and every run-start seam passes the
   * same root, so a plain assignment keeps the field truthful even if a seam
   * fires twice.
   */
  bindProjectRoot(root: string): void {
    this.projectRoot = root;
  }

  /**
   * Read the project's `Gemfile` ONCE per run (guarded by `gemfileLoaded`) so
   * the Ruby resolver can gate DSL grammar to the declared gems. The provider is
   * already a file-walking provider (see `extractOneFile`), so reading one root
   * manifest is in-domain; it forwards the RAW string to every `CallContext` and
   * the parse lives in the resolver (`catalogueForGemfile`). Absent / unreadable
   * Gemfile ⇒ `undefined` ⇒ FULL catalogue (gating off). bd tea-rags-mcp-adx5p.1.
   */
  loadGemfile(root: string): void {
    if (this.gemfileLoaded) return;
    this.gemfileLoaded = true;
    try {
      this.gemfileContent = readFileSync(join(root, "Gemfile"), "utf8");
    } catch {
      this.gemfileContent = undefined;
    }
  }

  /**
   * Read every registered language's persisted-schema snapshot ONCE per run
   * (bd tea-rags-mcp-8l5fo). Same shape and rationale as `loadGemfile`: a
   * root-relative manifest read is in-domain for a file-walking provider, and
   * the barrier (`seal`) — where the pre-pass runs — never sees `root`. An
   * absent or unreadable snapshot is a clean no-op (the project simply has no
   * schema).
   */
  loadSchemaSnapshots(root: string): void {
    if (this.schemaSnapshotsLoaded) return;
    this.schemaSnapshotsLoaded = true;
    for (const source of this.schemaColumnSources) {
      try {
        this.schemaSnapshots[source.schemaRelPath] = readFileSync(join(root, source.schemaRelPath), "utf8");
      } catch {
        // No snapshot for this language in this project — nothing to synthesize.
      }
    }
  }

  /**
   * Synthesize the persisted-schema column accessors onto their owning models
   * and publish them into the run's symbol table (bd tea-rags-mcp-8l5fo). Runs
   * at the pass-1→pass-2 barrier (`seal`), where BOTH inputs are complete for
   * the first time: the ancestry map (which classes are models) and the
   * explicit table overrides.
   *
   * The definitions are deliberately NOT persisted to `cg_symbols` — they are
   * derived from a file that is not part of the call graph, and the pre-pass
   * rebuilds them on every run (same lifecycle as `hierarchyView`).
   */
  private applySchemaColumns(symbolTable: GlobalSymbolTable): Record<string, RubyTypeRef> {
    if (symbolTable.setSchemaColumns === undefined) return {};
    const definitions: SymbolDefinition[] = [];
    // Column VALUE types (bd tea-rags-mcp-2a5oo) — returned rather than merged
    // here, because they rank BELOW every other return fact and the barrier's
    // derived facts are not all folded yet at this point.
    const returnTypes: Record<string, RubyTypeRef> = {};
    for (const source of this.schemaColumnSources) {
      const snapshot = this.schemaSnapshots[source.schemaRelPath];
      if (snapshot === undefined) continue;
      const models = collectSchemaColumnModels({
        classAncestors: this.ancestors,
        declaredTables: this.schemaTables,
        modelBaseClasses: source.modelBaseClasses,
        symbolTable,
      });
      const {
        definitions: synthesized,
        returnTypes: synthesizedTypes,
        stats,
      } = synthesizeSchemaColumnDefs(source.parseSchema(snapshot), models, source.modelNameForTable);
      definitions.push(...synthesized);
      Object.assign(returnTypes, synthesizedTypes);
      if (isDebug()) {
        console.error("[GitEnrich] PHASE: CODEGRAPH_SCHEMA_COLUMNS", {
          schema: source.schemaRelPath,
          ...stats,
        });
      }
    }
    symbolTable.setSchemaColumns(definitions);
    return returnTypes;
  }

  /**
   * Pass-1→pass-2 barrier (bd tea-rags-mcp-o17v2 + cai0/2oky5 + DEFECT 2).
   * Pass-1 is complete, so the run-global maps are frozen: build the hierarchy
   * view and the reverse include-by index ONCE here instead of per file, then
   * discover the self-dispatch templates.
   *
   * `resolveSymbolTable` is LAZY on purpose — the symbol table is only needed
   * for the self-dispatch discovery branch, and resolving it eagerly would add
   * a pool acquire to every run that has no self-dispatch candidates.
   */
  async seal(resolveSymbolTable: () => Promise<GlobalSymbolTable>): Promise<void> {
    this.hierarchyView = new MapHierarchyView(buildHierarchySnapshot(this.inheritanceRows));
    this.includedBy = buildIncludedBy(this.ancestors, this.prependedAncestors);
    // Persisted-schema column accessors (bd tea-rags-mcp-8l5fo). Composed at
    // this same barrier and for the same reason as the discovery below: only
    // here are the run-global ancestry map (which classes are models) and the
    // explicit `self.table_name` overrides both complete. Pass-2's typed and
    // MRO lookups then find a column exactly like any other member. The column
    // VALUE types are held back and merged LAST (below).
    let schemaColumnReturnTypes: Record<string, RubyTypeRef> = {};
    if (this.schemaColumnSources.length > 0) {
      schemaColumnReturnTypes = this.applySchemaColumns(await resolveSymbolTable());
    }
    if (this.selfDispatchMethods.length > 0) {
      const symbolTable = await resolveSymbolTable();
      const selfDispatchProbe = buildSelfDispatchProbe(symbolTable, this.hierarchyView);
      this.selfDispatchTemplates = foldSelfDispatchTemplates(
        discoverSelfDispatchTemplates(this.selfDispatchMethods, selfDispatchProbe),
      );
      this.selfInstantiatingClassMethods = collectSelfInstantiatingClassMethods(this.selfDispatchMethods);
      // Service-entry RETURN threading (bd tea-rags-mcp-j9xpf). The walker
      // types the SHARED template's return (`KindOfService#call` →
      // `KindOfService::Result`); call sites name a CONCRETE entry constant.
      // Both entry channels just discovered enumerate that relation, so the
      // join belongs HERE — the only point where the walker's run-global
      // return facts and the wiring hierarchy are both complete. Merged
      // DERIVED-last into the same map it read: the helper skips coordinates
      // already carrying a declared fact, so YARD / associations /
      // body-last-expr keep precedence by construction.
      //
      // The existence oracle (bd tea-rags-mcp-yt3im) is what makes "declared
      // wins" checkable: a fact naming a type this run declares nowhere — no
      // symbol-table entry, no ancestry — is an annotation fiction and does not
      // outrank a derivation. Both inputs are complete exactly here, which is
      // why the predicate is built at this barrier rather than passed in.
      const entryReturnTypes = deriveServiceEntryReturnTypes(
        [...this.selfInstantiatingClassMethods, ...Object.keys(this.selfDispatchTemplates)],
        this.structuredReturnTypes,
        selfDispatchProbe.relatedConcreteTypes,
        (typeName) => symbolTable.lookup(typeName).length > 0 || this.ancestors[typeName] !== undefined,
      );
      for (const [key, ref] of Object.entries(entryReturnTypes)) {
        this.structuredReturnTypes[key] = ref;
        this.markContributed("structuredReturnTypes");
      }
    }
    // Persisted-schema column VALUE types (bd tea-rags-mcp-2a5oo), merged
    // LAST and only where the coordinate is still empty. A column accessor
    // has no `def` in source, so ANY other fact at `Model#col` — a YARD
    // `@return`, an association, a body-inferred return, a service-entry
    // derivation — describes a real declaration that shadows the column and
    // must win. The schema is the fallback of last resort, exactly as the
    // `schemaColumn` resolution strategy is the chain's last pass.
    for (const [key, ref] of Object.entries(schemaColumnReturnTypes)) {
      if (key in this.structuredReturnTypes) continue;
      // Barrier-derived, but a contribution all the same: a run where no FILE
      // typed a structured return yet the schema pre-pass did must still read
      // as populated, or pass-2 falls back to per-file maps that lack these.
      this.structuredReturnTypes[key] = ref;
      this.markContributed("structuredReturnTypes");
    }
    // Interprocedural PARAMETER typing, Increment 1 (bd tea-rags-mcp-bvalc).
    // Composed at this barrier for the same reason as the folds above: only
    // here is the run's method-definition index complete, so a call site's
    // constant-lookup candidates can be gated against real defs. The fold
    // consumes NO resolution result — that is what lets it run before pass-2
    // rather than needing a fixpoint with it.
    if (this.knownTargetCallArgs.size > 0) {
      this.paramTypes = foldKnownTargetParamTypes(this.knownTargetCallArgs.values(), this.paramNames);
      this.derivedClassFieldTypes = deriveClassFieldTypesFromParams(
        this.classFieldParamLinks,
        this.paramTypes,
        this.typedClassFields,
      );
    }
  }

  /**
   * Clear the interprocedural parameter-typing run state (bd tea-rags-mcp-bvalc)
   * — the pass-1 accumulators AND the barrier products. One method rather than
   * six inline assignments repeated at each of the run-reset seams: a future
   * field added to this mechanism cannot be forgotten at one of them and leak
   * facts from a previous run into the next.
   */
  private resetInterprocParamState(): void {
    this.knownTargetCallArgs.clear();
    this.paramNames = {};
    this.classFieldParamLinks = {};
    this.typedClassFields.clear();
    this.paramTypes = {};
    this.derivedClassFieldTypes = {};
  }

  /**
   * Read-and-clear the per-run counters for
   * `EnrichmentMetrics.byProvider["codegraph.symbols"]`. Returning the snapshot
   * resets internal state so the next enrichment cycle starts at zero;
   * CompletionRunner calls this once per cycle.
   *
   * An empty run (no files extracted, no edges) performs the WIDE reset and
   * reports `undefined`; a real run resets only the tally plus the ancestor /
   * gemfile inputs. The asymmetry is inherited from the pre-split provider and
   * is pinned by `provider-run-reset-seams.test.ts`.
   */
  drainMetrics(): ProviderRunMetrics | undefined {
    const {
      extractedFiles,
      fileEdgeCount,
      methodEdgeCount,
      callsAttempted,
      callsResolved,
      callsExternalSkipped,
      callsUnresolvable,
      callsNoInProjectDef,
      callsCoreAmbiguous,
    } = this.stats;
    if (extractedFiles === 0 && fileEdgeCount === 0 && methodEdgeCount === 0) {
      this.stats = createEmptyRunStats();
      this.ancestors = {};
      this.compactClasses = new Set();
      this.gemfileContent = undefined;
      this.gemfileLoaded = false;
      this.projectRoot = undefined;
      this.prependedAncestors = {};
      this.classExtends = {};
      this.schemaTables = {};
      this.schemaSnapshots = {};
      this.schemaSnapshotsLoaded = false;
      this.returnTypes = {};
      this.instantiatedTypes.clear();
      this.ivarTypes = {};
      this.structuredReturnTypes = {};
      this.dispatchTables = {};
      this.callbackParams = {};
      this.inheritanceRows = [];
      this.hierarchyView = undefined;
      this.selfDispatchMethods = [];
      this.selfDispatchTemplates = {};
      this.selfInstantiatingClassMethods = [];
      this.resetInterprocParamState();
      // The wide reset emptied every run-global map, so every flag goes with it.
      this.clearContributed();
      return undefined;
    }
    // tea-rags-mcp-ykj7 + cai0.2 (Option A) — the denominator excludes
    // external-library calls (ykj7), dynamic-undeterminable calls, AND calls
    // whose member has no in-project def (`callsNoInProjectDef`): a member with
    // zero in-project definitions can never resolve to an in-project symbol, so
    // it is not a resolver failure (the same exclusion inProjectEdgeRecall
    // applies). With the four terms excluded the rate equals inProjectEdgeRecall
    // by construction. `max(1, …)` guards a divide-by-zero when every attempted
    // call was external / no-in-project-def.
    const internalAttempted = Math.max(
      1,
      callsAttempted - callsExternalSkipped - callsUnresolvable - callsNoInProjectDef - callsCoreAmbiguous,
    );
    const resolveSuccessRate = callsAttempted === 0 ? 0 : callsResolved / internalAttempted;
    // inProjectEdgeRecall — graph completeness. A genuine miss whose member has
    // no in-project definition (callsNoInProjectDef) can never yield an edge, so
    // it is excluded; likewise a core homonym reached through an untyped receiver
    // (callsCoreAmbiguous, bd 83cl7) — its in-project def is a same-name
    // coincidence, the real callee is the runtime. Only the residual misses WITH
    // an in-project def are true recall holes.
    const missWithInProjectDef = Math.max(
      0,
      callsAttempted -
        callsResolved -
        callsExternalSkipped -
        callsUnresolvable -
        callsNoInProjectDef -
        callsCoreAmbiguous,
    );
    const recallDenominator = callsResolved + missWithInProjectDef;
    const inProjectEdgeRecall = recallDenominator === 0 ? 0 : callsResolved / recallDenominator;
    const byReceiverKind = aggregateReceiverKinds(this.stats);
    const resolveByReceiverKind = Object.fromEntries(
      RECEIVER_KINDS.map((kind) => {
        const t = byReceiverKind[kind];
        return [
          kind,
          { attempted: t.attempted, resolved: t.resolved, rate: t.attempted === 0 ? 0 : t.resolved / t.attempted },
        ];
      }),
    );
    // One-line per-idiom diagnostic (bd tea-rags-mcp-j431): surfaces the
    // resolve breakdown to mcp-logs once per enrichment cycle so each cai0
    // slice's delta is readable without a DTO change. Mirrors the unconditional
    // `[codegraph]` diagnostics elsewhere in this provider.
    if (callsAttempted > 0) {
      const summary = RECEIVER_KINDS.map((kind) => {
        const t = byReceiverKind[kind];
        return `${kind} ${t.resolved}/${t.attempted}`;
      }).join(", ");
      process.stderr.write(
        `[codegraph] resolve by receiver-kind (rate ${resolveSuccessRate.toFixed(2)}, ` +
          `${callsExternalSkipped}/${callsAttempted} external-skipped, ` +
          `${callsUnresolvable} unresolvable): ${summary}\n`,
      );
    }
    this.stats = createEmptyRunStats();
    this.ancestors = {};
    this.compactClasses = new Set();
    this.gemfileContent = undefined;
    this.gemfileLoaded = false;
    this.projectRoot = undefined;
    this.schemaSnapshots = {};
    this.schemaSnapshotsLoaded = false;
    this.prependedAncestors = {};
    // ONLY these two: the real-run branch deliberately leaves classExtends,
    // returnTypes, ivarTypes and structuredReturnTypes standing, and clearing
    // their flags here would send pass-2 to the per-file fallback while the
    // run-global maps still hold facts. The asymmetry is inherited from the
    // pre-split provider and pinned by provider-run-reset-seams.test.ts.
    this.clearContributed(["ancestors", "prependedAncestors"]);
    return {
      extractedFiles,
      fileEdgeCount,
      methodEdgeCount,
      resolveSuccessRate,
      inProjectEdgeRecall,
      callsResolved,
      callsExternalSkipped,
      callsUnresolvable,
      callsNoInProjectDef,
      callsCoreAmbiguous,
      resolveByReceiverKind,
    };
  }

  /**
   * Map the in-memory per-(language, receiver-kind) tally (bd
   * tea-rags-mcp-cnqrg, extends j431) to persistable rows. The client
   * overwrites the whole table so stale prior-run cells never leak; a language
   * absent from this run simply has no rows. The tally is NOT reset here —
   * `drainMetrics` owns read-and-clear.
   */
  toResolveRunStatsRows(): ResolveRunStatsRow[] {
    const rows: ResolveRunStatsRow[] = [];
    for (const [language, kinds] of this.stats.byLanguageKind) {
      for (const kind of RECEIVER_KINDS) {
        const t = kinds[kind];
        rows.push({
          language,
          receiverKind: kind,
          attempted: t.attempted,
          resolved: t.resolved,
          externalSkipped: t.externalSkipped,
          unresolvable: t.unresolvable,
          noInProjectDef: t.noInProjectDef,
          coreAmbiguous: t.coreAmbiguous,
          ambiguousFanout: t.ambiguousFanout,
        });
      }
    }
    return rows;
  }

  /**
   * Zero the per-run resolve tally at a run-START seam. On the long-lived daemon
   * the provider instance is cached and reused, so unless every run-start path
   * zeroes the tally, a prior run whose `drainMetrics` never fired leaks its
   * counts into this run and jitters `resolveSuccessRate` run-to-run
   * (bd tea-rags-mcp-svhqp).
   */
  resetTally(): void {
    this.stats = createEmptyRunStats();
  }

  /**
   * Release per-run extraction state after finalize: reset the run-global
   * ancestor / extends / return-type / dispatch maps. Unlike `drainMetrics`
   * this also clears `includedBy` and leaves the resolve tally intact —
   * `drainMetrics` owns read-and-clear of the tally.
   */
  clearForNextRun(): void {
    this.ancestors = {};
    this.extractedFilesByLanguage.clear();
    this.extractedRelPathsByLanguage.clear();
    this.compactClasses = new Set();
    this.gemfileContent = undefined;
    this.gemfileLoaded = false;
    this.projectRoot = undefined;
    this.prependedAncestors = {};
    this.includedBy = {};
    this.classExtends = {};
    this.schemaTables = {};
    this.schemaSnapshots = {};
    this.schemaSnapshotsLoaded = false;
    this.returnTypes = {};
    this.instantiatedTypes.clear();
    this.ivarTypes = {};
    this.structuredReturnTypes = {};
    this.dispatchTables = {};
    this.callbackParams = {};
    this.inheritanceRows = [];
    this.hierarchyView = undefined;
    this.selfDispatchMethods = [];
    this.selfDispatchTemplates = {};
    this.selfInstantiatingClassMethods = [];
    this.resetInterprocParamState();
    this.clearContributed();
  }

  /**
   * Worker-pool release: drop every run-global aggregate. Mirrors
   * `clearForNextRun` minus `includedBy` and minus the tally — both inherited
   * verbatim from the pre-split `onRelease` and pinned by
   * `provider-run-reset-seams.test.ts`.
   */
  clearAll(): void {
    this.ancestors = {};
    this.extractedFilesByLanguage.clear();
    this.extractedRelPathsByLanguage.clear();
    this.compactClasses = new Set();
    this.gemfileContent = undefined;
    this.gemfileLoaded = false;
    this.projectRoot = undefined;
    this.prependedAncestors = {};
    this.classExtends = {};
    this.schemaTables = {};
    this.schemaSnapshots = {};
    this.schemaSnapshotsLoaded = false;
    this.returnTypes = {};
    this.instantiatedTypes.clear();
    this.ivarTypes = {};
    this.structuredReturnTypes = {};
    this.dispatchTables = {};
    this.callbackParams = {};
    this.inheritanceRows = [];
    this.hierarchyView = undefined;
    this.selfDispatchMethods = [];
    this.selfDispatchTemplates = {};
    this.selfInstantiatingClassMethods = [];
    this.resetInterprocParamState();
    this.clearContributed();
  }

  /**
   * Merge one file's pass-1 aggregates into the run-global maps. Called by the
   * extraction sink's `write` for every file walked in pass-1. Last-write-wins
   * on duplicate keys — same-class declarations across files are rare, and when
   * they happen the later definition is what the runtime would see too.
   */
  absorb(extraction: FileExtraction, selfDispatchMethods: SelfDispatchMethod[]): void {
    // Counted here rather than beside `stats.extractedFiles` in the sink
    // because this is a run-global aggregate the pass-2 barrier reads, and
    // `absorb` is where those are assembled. The defensive empty extraction
    // carries `language: ""` and is not a file any resolver will be handed.
    if (extraction.language !== "") {
      this.extractedFilesByLanguage.set(
        extraction.language,
        (this.extractedFilesByLanguage.get(extraction.language) ?? 0) + 1,
      );
      const relPaths = this.extractedRelPathsByLanguage.get(extraction.language);
      if (relPaths === undefined) this.extractedRelPathsByLanguage.set(extraction.language, [extraction.relPath]);
      else relPaths.push(extraction.relPath);
    }
    if (extraction.classAncestors) {
      for (const [k, v] of Object.entries(extraction.classAncestors)) {
        this.ancestors[k] = v;
        this.markContributed("ancestors");
      }
    }
    if (extraction.compactDeclaredClasses) {
      for (const fq of extraction.compactDeclaredClasses) this.compactClasses.add(fq);
    }
    if (extraction.classPrependedAncestors) {
      for (const [k, v] of Object.entries(extraction.classPrependedAncestors)) {
        this.prependedAncestors[k] = v;
        this.markContributed("prependedAncestors");
      }
    }
    if (extraction.classExtends) {
      for (const [k, v] of Object.entries(extraction.classExtends)) {
        this.classExtends[k] = v;
        this.markContributed("classExtends");
      }
    }
    // Explicit ORM table overrides (`self.table_name`), merged run-global so
    // the schema-column pre-pass at the barrier sees every declaration in the
    // project regardless of which file carries it (bd tea-rags-mcp-8l5fo).
    if (extraction.classSchemaTables) {
      for (const [k, v] of Object.entries(extraction.classSchemaTables)) {
        this.schemaTables[k] = v;
      }
    }
    // Merge file-local function return types into the run-global map so the
    // resolver in pass-2 can resolve `x := New()` return-type bindings keyed by
    // function name regardless of which file declares the function. bd
    // tea-rags-mcp-6g9c. Last write wins on duplicate names; the resolver's
    // symbol-table existence gate suppresses any wrong type that survives the
    // collision.
    if (extraction.functionReturnTypes) {
      for (const [k, v] of Object.entries(extraction.functionReturnTypes)) {
        this.returnTypes[k] = v;
        this.markContributed("returnTypes");
      }
    }
    // Merge the Ruby type-source PRECISE maps run-global so the resolver's
    // precise `@ivar.method()` / structured-return paths see annotated types
    // keyed by class regardless of which file declared the class/method
    // (Increment 1, Task 1.5). Last-write-wins, mirroring functionReturnTypes.
    if (extraction.ivarTypes) {
      for (const [k, v] of Object.entries(extraction.ivarTypes)) {
        this.ivarTypes[k] = v;
        this.markContributed("ivarTypes");
      }
    }
    if (extraction.structuredReturnTypes) {
      for (const [k, v] of Object.entries(extraction.structuredReturnTypes)) {
        this.structuredReturnTypes[k] = v;
        this.markContributed("structuredReturnTypes");
      }
    }
    // Union this file's instantiation set into the run-global RTA set so the
    // cone resolver in pass-2 prunes by program-wide instantiation regardless of
    // which file instantiates the type. bd tea-rags-mcp-pffv.
    if (extraction.instantiatedTypes) {
      for (const t of extraction.instantiatedTypes) {
        this.instantiatedTypes.add(t);
      }
    }
    // Merge dispatch tables run-global keyed by table name + defining relpath so
    // the resolver can fan a `TABLE[key].field()` call out to every candidate
    // regardless of which file declared the table (bd tea-rags-mcp-n0zj).
    // Re-walking a file replaces its own def for that name (dedup by relPath) —
    // incremental reindex stays idempotent.
    if (extraction.dispatchTables) {
      for (const [name, table] of Object.entries(extraction.dispatchTables)) {
        const defs = (this.dispatchTables[name] ??= []);
        const at = defs.findIndex((d) => d.relPath === extraction.relPath);
        if (at >= 0) defs[at] = { relPath: extraction.relPath, table };
        else defs.push({ relPath: extraction.relPath, table });
      }
    }
    // Merge callback-param maps run-global keyed by symbolId so the bounded
    // inter-proc join sees a callee's invoked param positions even when the call
    // site is in a different file.
    if (extraction.callbackParams) {
      for (const [symbolId, indices] of Object.entries(extraction.callbackParams)) {
        this.callbackParams[symbolId] = indices;
      }
    }
    if (selfDispatchMethods.length > 0) this.selfDispatchMethods.push(...selfDispatchMethods);
    // Interprocedural param typing, Increment 1 (bd tea-rags-mcp-bvalc).
    // LIGHT records again: the deduped call-arg shapes, the positional
    // param-name index off the chunks, the `@ivar = <param>` links, and
    // the coordinates the walker already typed (the derivation's gate).
    // Ruby-only, like the self-dispatch candidates — the consuming fold
    // and resolver paths are Ruby.
    if (extraction.language === "ruby") {
      for (const record of extraction.knownTargetCallArgs ?? []) {
        this.knownTargetCallArgs.set(`${record.targets.join("|")} ${JSON.stringify(record.argTypes)}`, record);
      }
      for (const chunk of extraction.chunks) {
        if (chunk.paramNames !== undefined) this.paramNames[chunk.symbolId] = chunk.paramNames;
      }
      for (const [fqClass, fields] of Object.entries(extraction.classFieldParamLinks ?? {})) {
        this.classFieldParamLinks[fqClass] = { ...this.classFieldParamLinks[fqClass], ...fields };
      }
      for (const [fqClass, fields] of Object.entries(extraction.classFieldTypes ?? {})) {
        for (const ivar of Object.keys(fields)) this.typedClassFields.add(`${fqClass}|${ivar}`);
      }
    }
  }
}
