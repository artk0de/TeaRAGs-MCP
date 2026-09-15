/**
 * Per-run state of the codegraph symbols provider (bd tea-rags-mcp-6vfrj / G2).
 *
 * Pass-1 (`sink.write` → `absorb`) merges each file's aggregates into the
 * run-global maps held here; the pass-1→pass-2 barrier (`seal`) builds the
 * hierarchy view, reverse include-by index and self-dispatch templates; pass-2
 * (`CallEdgeResolutionRunner`) reads them for every `CallContext` and tallies
 * resolve outcomes back into `stats`.
 *
 * The reset seams (`resetTally` / `clearForNextRun` / `clearAll` / `drainMetrics`)
 * clear overlapping but NOT identical field sets on purpose: unifying them is a
 * behaviour change and needs its own TDD cycle.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ClassFieldParamLink,
  CodegraphPass1FileAggregates,
  DispatchTableDef,
  FileExtraction,
  FileResolveStatsEntry,
  GlobalSymbolTable,
  HierarchyView,
  InheritanceEdgeRow,
  KnownTargetCallArgs,
  ModuleReexport,
  RelPath,
  ResolveRunScope,
  ResolveRunStatsRow,
  SymbolDefinition,
} from "../../../../contracts/types/codegraph.js";
import type {
  DependencyManifestSource,
  RubyTypeRef,
  SchemaColumnAccessorSource,
} from "../../../../contracts/types/language.js";
import type { ProviderRunMetrics } from "../../../../contracts/types/provider.js";
import { readDeclaredDependencies } from "../../../../infra/dependency-manifests.js";
import { isDebug } from "../../../../infra/runtime.js";
import { MapHierarchyView } from "../hierarchy-view.js";
import {
  deriveClassFieldTypesFromParams,
  foldKnownTargetParamTypes,
  type KnownTargetParamTypes,
} from "./call-arg-param-types.js";
import { buildHierarchySnapshot, normalizeInheritanceEdges } from "./inheritance-edges.js";
import { selectHydratablePass1Aggregates } from "./pass1-aggregates.js";
import { RECEIVER_KINDS, type ReceiverKind } from "./receiver-kind.js";
import {
  HYDRATED_RUN_GLOBAL_MAPS,
  type HydratedRunGlobalMapField,
  type Pass1AggregateSlice,
} from "./run-global-map-registry.js";
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
  // tea-rags-mcp-ykj7 — unresolved-but-external calls (subset of attempted −
  // resolved). Persisted to cg_run_stats.external_skipped.
  externalSkipped: number;
  // bd cai0 — unresolved-but-statically-undeterminable calls (dynamic send(var)).
  // Persisted to cg_run_stats.unresolvable.
  unresolvable: number;
  // Unresolved calls whose member has NO in-project definition; excluded from
  // the inProjectEdgeRecall denominator. Persisted to cg_run_stats.no_in_project_def.
  noInProjectDef: number;
  // bd tea-rags-mcp-83cl7 — unresolved CORE/runtime names on an UNTYPED receiver,
  // where a project homonym defeats the noInProjectDef gate; excluded from the
  // recall denominator. Persisted to cg_run_stats.core_ambiguous.
  coreAmbiguous: number;
  // bd f2jsb/j0pki — over-cap-ambiguous dispatch fan-outs (subset of attempted −
  // resolved): neither a genuine miss nor external. Persisted to cg_run_stats.ambiguous_fanout.
  ambiguousFanout: number;
  // bd tea-rags-mcp-znxg8 — RESOLVED calls that landed on a shared self-dispatch
  // entry node instead of the concrete hook the constant receiver names. Not a
  // miss and read by no rate: an invariant that sits near zero while entry
  // narrowing works. Persisted to cg_run_stats.unnarrowed_template.
  unnarrowedTemplate: number;
}

export interface RunStats {
  extractedFiles: number;
  fileEdgeCount: number;
  methodEdgeCount: number;
  callsAttempted: number;
  callsResolved: number;
  // tea-rags-mcp-ykj7 — unresolved calls targeting an external library / runtime
  // (`Math.max`, `Net::HTTP.get`), excluded from the resolveSuccessRate
  // denominator. Subset of (callsAttempted − callsResolved).
  callsExternalSkipped: number;
  // bd cai0 — unresolved dynamic send(var) calls with a non-literal target, excluded
  // from the resolveSuccessRate denominator. Subset of (callsAttempted −
  // callsResolved − callsExternalSkipped).
  callsUnresolvable: number;
  // Genuine misses whose member short-name has NO in-project definition — they
  // can never yield an in-project edge, so inProjectEdgeRecall excludes them.
  // Subset of (callsAttempted − callsResolved − callsExternalSkipped − callsUnresolvable).
  callsNoInProjectDef: number;
  // bd tea-rags-mcp-83cl7 — genuine misses on a CORE/runtime name (`each`, `to_s`)
  // through an UNTYPED receiver, whose project def is a same-name coincidence.
  // Excluded from both denominators exactly like callsNoInProjectDef.
  callsCoreAmbiguous: number;
  // bd f2jsb/j0pki — over-cap AMBIGUOUS dispatch fan-outs recorded as a
  // cg_ambiguous_fanout aggregate instead of m edges. Strict recall keeps them in
  // the denominator; coveredRecall counts them as coverage.
  callsAmbiguousFanout: number;
  // Per-(language, receiver kind) tally (bd tea-rags-mcp-cnqrg, extends j431): the
  // source every aggregate above and every per-kind / per-language summary sums
  // from; persisted per cell to cg_run_stats. Test files never reach it — the
  // codegraph exclusion filter drops them at extraction.
  byLanguageKind: Map<string, Record<ReceiverKind, ReceiverKindTally>>;
  // bd tea-rags-mcp-xpmwg — the same counts per CALLER FILE, for
  // `cg_file_resolve_stats`. One entry per file the run resolved, zero-call
  // files included: a file whose calls all went away must still replace its
  // persisted rows with none. Only kinds the file tallied a call under are kept.
  // Summing it per (language, kind) gives exactly `byLanguageKind`.
  byFile: Map<RelPath, FileResolveTally>;
}

/** One caller file's resolve tally (bd tea-rags-mcp-xpmwg). */
export interface FileResolveTally {
  language: string;
  kinds: Map<ReceiverKind, ReceiverKindTally>;
}

function zeroReceiverKindTally(): ReceiverKindTally {
  return {
    attempted: 0,
    resolved: 0,
    externalSkipped: 0,
    unresolvable: 0,
    noInProjectDef: 0,
    coreAmbiguous: 0,
    ambiguousFanout: 0,
    unnarrowedTemplate: 0,
  };
}

export function emptyReceiverKindTally(): Record<ReceiverKind, ReceiverKindTally> {
  const out = {} as Record<ReceiverKind, ReceiverKindTally>;
  for (const kind of RECEIVER_KINDS) out[kind] = zeroReceiverKindTally();
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

/** Add every counter of `source` onto `target`. */
function addReceiverKindTally(target: ReceiverKindTally, source: ReceiverKindTally): void {
  target.attempted += source.attempted;
  target.resolved += source.resolved;
  target.externalSkipped += source.externalSkipped;
  target.unresolvable += source.unresolvable;
  target.noInProjectDef += source.noInProjectDef;
  target.coreAmbiguous += source.coreAmbiguous;
  target.ambiguousFanout += source.ambiguousFanout;
  target.unnarrowedTemplate += source.unnarrowedTemplate;
}

/**
 * Fold one resolved file's per-kind tally into BOTH run views (bd
 * tea-rags-mcp-xpmwg): the per-(language, kind) totals the run has always
 * reported, and the per-file entry `cg_file_resolve_stats` persists. Registers
 * the language and the file even when every counter is zero — a walked file with
 * no call site is still a resolved file.
 */
export function foldFileKindTally(
  stats: RunStats,
  relPath: RelPath,
  language: string,
  fileKinds: Record<ReceiverKind, ReceiverKindTally>,
): void {
  const languageKinds = languageKindTally(stats, language);
  let file = stats.byFile.get(relPath);
  if (!file) {
    file = { language, kinds: new Map() };
    stats.byFile.set(relPath, file);
  }
  for (const kind of RECEIVER_KINDS) {
    const tally = fileKinds[kind];
    addReceiverKindTally(languageKinds[kind], tally);
    if (tally.attempted === 0) continue;
    let persisted = file.kinds.get(kind);
    if (!persisted) {
      persisted = zeroReceiverKindTally();
      file.kinds.set(kind, persisted);
    }
    addReceiverKindTally(persisted, tally);
  }
}

/**
 * Project the per-(language, kind) tally onto the per-receiver-kind axis by
 * summing across languages — the j431 view consumed by getRunMetrics.
 */
export function aggregateReceiverKinds(stats: RunStats): Record<ReceiverKind, ReceiverKindTally> {
  const out = emptyReceiverKindTally();
  for (const kinds of stats.byLanguageKind.values()) {
    for (const kind of RECEIVER_KINDS) addReceiverKindTally(out[kind], kinds[kind]);
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
    byFile: new Map(),
  };
}

/**
 * Reverse include-by index (bd cai0/2oky5): `out[X]` lists every class that has
 * X as a direct ancestor (superclass, include or prepend). Consumed by the Ruby
 * `super` module-method fallback.
 *
 * Lives here rather than in `provider.ts` so `run-state.ts` does not import its
 * own consumer (a module cycle); `provider.ts` re-exports it for import stability.
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
 * between the run-global fact and the calling file's own (bd tea-rags-mcp-8zwl9).
 * `instantiatedTypes` is absent: a `Set` already answers `.size` in O(1).
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

let lastResolveRunSeq = 0;

/** A fresh {@link ResolveRunScope}; see `CodegraphRunState#runScope`. */
function mintResolveRunScope(): ResolveRunScope {
  lastResolveRunSeq += 1;
  return Object.freeze({ runSeq: lastResolveRunSeq });
}

export class CodegraphRunState {
  /**
   * Persisted-schema column vocabularies of the registered languages (bd
   * tea-rags-mcp-8l5fo), collected ONCE by the provider's constructor because
   * `factory.create` is expensive. Empty ⇒ the schema pre-pass never runs.
   */
  constructor(
    private readonly schemaColumnSources: readonly SchemaColumnAccessorSource[] = [],
    /**
     * Dependency-manifest readers of the registered languages (bd
     * tea-rags-mcp-w205u.1), collected the same way. Empty ⇒ the manifest walk
     * never runs and every framework vocabulary stays active.
     */
    private readonly dependencyManifestSources: readonly DependencyManifestSource[] = [],
  ) {}

  /**
   * Per-run counters surfaced via `getRunMetrics()`, read-and-cleared by
   * `CompletionRunner` once per cycle. Held here, not in the sink, so they
   * survive several sink.write/finish pairs within one run (backfill paths).
   */
  stats: RunStats = createEmptyRunStats();

  /**
   * Files pass-1 absorbed, per language — the pass-2 file count, known before
   * pass-2 starts (bd tea-rags-mcp-6aytq). `prepareResolvePass` hands each
   * language its own figure so a resolver primes run-scoped caches only for a
   * bulk pass. Per LANGUAGE: 10,000 Ruby files and 40 TypeScript ones is not a
   * bulk pass for TypeScript.
   */
  readonly extractedFilesByLanguage = new Map<string, number>();

  /**
   * The same files, listed rather than counted (bd tea-rags-mcp-6aytq): the count
   * gates a bulk pass, the list is what a priming resolver builds over —
   * TypeScript roots its whole-project `ts.Program` on it, because the tsconfig
   * include set misses files the run resolves. Released at both clear seams.
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
   * The persisted pass-1 slices the MAIN thread read and injected for this run
   * (bd tea-rags-mcp-weno4, via `FileSignalOptions.pass1Aggregates`). The barrier
   * prefers them over its own `graphDb` read; undefined for direct/test callers,
   * which keep the read. Per-RUN and cleared at both release seams below: rows of
   * one collection must never hydrate the next run's registries.
   */
  injectedPass1Aggregates?: readonly CodegraphPass1FileAggregates[];

  /**
   * Per-run aggregation of `FileExtraction.classAncestors` across every file
   * walked in pass-1, keyed by class: a variable's bound type is usually declared
   * in a DIFFERENT file than the caller, so per-file ancestor maps are insufficient.
   */
  ancestors: Record<string, readonly string[]> = {};

  /**
   * Per-run set of FQs declared COMPACT (`class A::B::C`), aggregated from
   * `FileExtraction.compactDeclaredClasses`. Passed to the resolver ctx so
   * `canonicalizeAncestorFq` skips the nesting prefix-walk for them (bd
   * lawlq.3.7). Reset alongside ancestors.
   */
  compactClasses = new Set<string>();

  /**
   * Per-run aggregation of `FileExtraction.classPrependedAncestors` (bd
   * tea-rags-mcp-3jvn). Same lifecycle as `ancestors`; walked BEFORE the bound
   * class itself so prepended modules' methods shadow the class's own.
   */
  prependedAncestors: Record<string, readonly string[]> = {};

  /**
   * Reverse include-by index built ONCE from the frozen ancestor + prepended maps
   * at the barrier, not per file — `buildIncludedBy` has an inner O(n²) scan. Pass-2
   * reads it only when BOTH resolver ancestor inputs ARE the run-global maps; the
   * per-file fallback (single-file / test mode) still computes fresh.
   */
  includedBy: Record<string, string[]> = {};

  /**
   * Per-run aggregation of `FileExtraction.classExtends` (bd tea-rags-mcp-d29r):
   * single-inheritance parent map merged across files, so `super()` routes to the
   * parent regardless of which file declares it.
   */
  classExtends: Record<string, string> = {};

  /**
   * Per-run aggregation of `FileExtraction.classSchemaTables` (bd
   * tea-rags-mcp-8l5fo): `class FQ → explicit ORM table override`, read ONCE at
   * the barrier to decide which model owns each schema table. Lifecycle as `classExtends`.
   */
  schemaTables: Record<string, string> = {};

  /**
   * Raw persisted-schema snapshot contents for the CURRENT run, keyed by the
   * declaring language's `schemaRelPath` and read ONCE by {@link loadSchemaSnapshots}
   * — the barrier (`seal`) has no `root` of its own. bd tea-rags-mcp-8l5fo.
   */
  schemaSnapshots: Record<string, string> = {};
  private schemaSnapshotsLoaded = false;

  /**
   * Per-run aggregation of `FileExtraction.functionReturnTypes` (bd
   * tea-rags-mcp-6g9c): `functionName → declaredReturnTypeName`, so `x := New();
   * x.method()` binds even when `New` lives in another file. Lifecycle as `classExtends`.
   */
  returnTypes: Record<string, string> = {};

  /**
   * Per-run union of `FileExtraction.instantiatedTypes` (bd tea-rags-mcp-pffv),
   * so `ConeDispatchResolver` can RTA-prune a CHA cone regardless of which file
   * does the `Klass.new`. Lifecycle as `returnTypes`.
   */
  readonly instantiatedTypes = new Set<string>();

  /**
   * Per-run aggregation of `FileExtraction.ivarTypes` (`fqClassName → "@ivar" →
   * typeName`) for the precise `@ivar.method()` path. Last-write-wins on a
   * duplicate class key. Stays empty while no type source emits `kind:"ivar"`
   * facts (bd tea-rags-mcp-wr7ku) — expected, not a wiring defect.
   */
  ivarTypes: Record<string, Record<string, string>> = {};

  /**
   * Per-run aggregation of `FileExtraction.structuredReturnTypes`
   * (`"<fqClass>#method" → RubyTypeRef`) for the precise structured-return path,
   * which keeps union / container refs across files. Last-write-wins.
   */
  structuredReturnTypes: Record<string, RubyTypeRef> = {};

  /**
   * Per-run aggregation of `FileExtraction.classFieldTypesByClassKey` (bd
   * tea-rags-mcp-f0xaa): `"<relPath>::<dotted class FQ>" → field → typeName`, so
   * Python's MRO field fold sees a base class's fields from a subclass in another file.
   *
   * Deliberately NOT a {@link RunGlobalMapName}: every reader indexes it by key,
   * so an absent map reads the same as an empty one. Last-write-wins on a
   * duplicate class key, mirroring `ivarTypes`; reset at the same seams.
   */
  classFieldTypesByClassKey: Record<string, Record<string, string>> = {};

  /**
   * Per-run aggregation of `FileExtraction.classFieldCallResults` (bd
   * tea-rags-mcp-w205u, E4.6c): `"<relPath>::<dotted class FQ>" → field → callee
   * SPELLING` for fields a walker cannot type, folded ONE level against
   * `structuredReturnTypes` at resolve time. Same key shape and lifecycle as
   * `classFieldTypesByClassKey`. NOT persisted.
   */
  classFieldCallResults: Record<string, Record<string, string>> = {};

  /**
   * Per-run `FileExtraction.moduleReexports`, keyed by the relPath that wrote each
   * list (bd tea-rags-mcp-xpl83.3), so the import mapper can see past a package
   * that only re-exports a name. Assignment, not union: a re-walk must REPLACE
   * what the file said, never keep a statement it has since deleted.
   */
  moduleReexports: Record<string, readonly ModuleReexport[]> = {};

  /**
   * Per-run aggregation of `FileExtraction.dispatchTables` keyed by table NAME
   * (bd tea-rags-mcp-n0zj); several files may declare one name, and the resolver
   * disambiguates by the caller's import map. Re-walking a file replaces its own
   * entry (dedup by relPath).
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
   * Per-run normalized inheritance rows (bd tea-rags-mcp-o17v2), accumulated so
   * the barrier builds a complete `MapHierarchyView` BEFORE any file resolves:
   * edges are persisted per file DURING pass-2, so the DB is incomplete when the
   * first CHA cone needs `getDescendants`.
   */
  inheritanceRows: InheritanceEdgeRow[] = [];

  /**
   * Bidirectional class-hierarchy view built from `inheritanceRows` at the
   * barrier (bd tea-rags-mcp-o17v2) and threaded into every `CallContext.hierarchy`.
   * `undefined` until the barrier runs (and on reset) — the cone resolver treats
   * absent as "no cone".
   */
  hierarchyView: HierarchyView | undefined;

  /**
   * Per-run self-dispatch method candidates (DEFECT 2): one LIGHT record per
   * self-calling method (symbolId + enclosing type + bare hook names), never the
   * chunks, so the NDJSON-spill heap bound holds. Ruby files only.
   */
  selfDispatchMethods: SelfDispatchMethod[] = [];

  /**
   * Run-global `templateMethodSymbolId → abstractHookMember` map (DEFECT 2) built
   * at the barrier for every `CallContext.selfDispatchTemplates`. Empty until the
   * barrier runs — the Ruby entry strategy CONTINUEs when it is empty.
   */
  selfDispatchTemplates: Record<string, string> = {};

  /**
   * Run-global self-instantiating CLASS-method symbolIds (DEFECT 2 v2), built at
   * the barrier: the Ruby entry strategy bridges a class entry to the same-named
   * instance template (`self.call → new.call`). Empty until the barrier runs.
   */
  selfInstantiatingClassMethods: string[] = [];

  /**
   * Per-run known-target call-site argument types (bd tea-rags-mcp-bvalc), DEDUPED
   * by (targets, argTypes): the fold over agreement is idempotent, so identical
   * sites contribute one record while disagreeing sites still conflict. Ruby only.
   */
  readonly knownTargetCallArgs = new Map<string, KnownTargetCallArgs>();

  /**
   * Per-run method-definition index `symbolId → positional param names` (bd
   * tea-rags-mcp-bvalc). Maps an argument POSITION to a parameter NAME at the
   * barrier and, holding only real definitions, gates which constant-lookup
   * candidate is the actual callee.
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
   * Raw `Gemfile` contents for the CURRENT run, read ONCE by {@link loadGemfile}
   * and attached to every resolver `CallContext` so Ruby DSL grammar is gated to
   * this project's gems. `undefined` ⇒ no Gemfile ⇒ FULL catalogue. Reset
   * alongside `compactClasses` (bd tea-rags-mcp-adx5p.1).
   */
  gemfileContent: string | undefined = undefined;
  private gemfileLoaded = false;

  /**
   * Every dependency this run's project DECLARES, unioned across manifests and
   * normalized per language, read ONCE by {@link loadDeclaredDependencies}. The
   * Python walker gates its framework vocabularies on it. `undefined` = no
   * manifest anywhere ⇒ every vocabulary ACTIVE; an empty set gates every
   * conditional vocabulary off. Lifecycle as `gemfileContent` (bd tea-rags-mcp-w205u.1).
   */
  declaredDependencies: ReadonlySet<string> | undefined = undefined;
  private declaredDependenciesLoaded = false;

  /**
   * Absolute root of the project the CURRENT run indexes, recorded by
   * {@link bindProjectRoot} and attached to every resolver `CallContext`.
   * Resolvers with project-rooted state (TypeScript tsconfig / file probe /
   * `ts.Program`) bind to it lazily, because the provider is constructed before
   * any project is known. Lifecycle as `gemfileContent`.
   */
  projectRoot: string | undefined = undefined;

  /**
   * Has anything been written into each run-global map yet? Pass-2 asks once per
   * map per FILE; deriving it from `Object.keys` cost files × maps × map-size (bd
   * tea-rags-mcp-8zwl9). Written ONLY by {@link markContributed} /
   * {@link clearContributed} and read only by {@link hasRunGlobalEntries} — an
   * index can disagree with the map it describes, so its writers stay paired.
   */
  private readonly contributedRunGlobals: Record<RunGlobalMapName, boolean> = {
    ancestors: false,
    prependedAncestors: false,
    classExtends: false,
    returnTypes: false,
    ivarTypes: false,
    structuredReturnTypes: false,
  };

  private currentRunScope: ResolveRunScope = mintResolveRunScope();

  /**
   * The identity of the resolve run in progress (bd tea-rags-mcp-39xca.6),
   * handed to every `CallContext` through `ResolverInputs`. Minted afresh at the
   * pass-1→pass-2 barrier and at every reset seam, so a resolver memo keyed on
   * it cannot serve an earlier pass's answer — whatever the pooled symbol table,
   * or a channel written into in place, still looks like.
   */
  get runScope(): ResolveRunScope {
    return this.currentRunScope;
  }

  private beginRunScope(): void {
    this.currentRunScope = mintResolveRunScope();
  }

  /**
   * How one persisted pass-1 slice folds into each HYDRATED map (bd
   * tea-rags-mcp-39xca.6). Keyed by `HydratedRunGlobalMapField`, derived from
   * `RUN_GLOBAL_MAP_PERSISTENCE`: declaring a map `hydrate` fails the type check
   * until it has an entry here, and flipping one to `batchOnly` fails it until
   * the entry goes. Every entry reads its map through `this` at call time,
   * because the reset seams REASSIGN the maps.
   *
   * Every entry is batch-wins — a coordinate this run already walked is a FRESH
   * fact and outranks the persisted one, which still describes the file's
   * previous content.
   */
  private readonly pass1Hydrators: {
    readonly [M in HydratedRunGlobalMapField]: (slice: Pass1AggregateSlice) => void;
  } = {
    ancestors: (slice) => {
      for (const [k, v] of Object.entries(slice.classAncestors ?? {})) {
        if (k in this.ancestors) continue;
        this.ancestors[k] = v;
        this.markContributed("ancestors");
      }
    },
    prependedAncestors: (slice) => {
      for (const [k, v] of Object.entries(slice.classPrependedAncestors ?? {})) {
        if (k in this.prependedAncestors) continue;
        this.prependedAncestors[k] = v;
        this.markContributed("prependedAncestors");
      }
    },
    classExtends: (slice) => {
      for (const [k, v] of Object.entries(slice.classExtends ?? {})) {
        if (k in this.classExtends) continue;
        this.classExtends[k] = v;
        this.markContributed("classExtends");
      }
    },
    compactClasses: (slice) => {
      for (const fq of slice.compactDeclaredClasses ?? []) this.compactClasses.add(fq);
    },
    // Ancestor symbol_ids stay null exactly as they do on the pass-1 path: the
    // hierarchy view reads by fq NAME, and pass-2's per-file persist owns the
    // symbol_id binding for the rows it writes. Runs for EVERY slice, not only
    // one carrying `inheritanceEdges`: the legacy class* records feed it too.
    inheritanceRows: (slice) => {
      this.inheritanceRows.push(...normalizeInheritanceEdges(slice, () => null));
    },
    selfDispatchMethods: (slice) => {
      if (slice.selfDispatchMethods !== undefined) this.selfDispatchMethods.push(...slice.selfDispatchMethods);
    },
    // Return types (bd tea-rags-mcp-8qyax). `markContributed` matters here —
    // without it pass-2 falls back to each file's own maps, the batch-scoped
    // behaviour being repaired.
    structuredReturnTypes: (slice) => {
      for (const [k, v] of Object.entries(slice.structuredReturnTypes ?? {})) {
        if (k in this.structuredReturnTypes) continue;
        this.structuredReturnTypes[k] = v;
        this.markContributed("structuredReturnTypes");
      }
    },
    returnTypes: (slice) => {
      for (const [k, v] of Object.entries(slice.functionReturnTypes ?? {})) {
        if (k in this.returnTypes) continue;
        this.returnTypes[k] = v;
        this.markContributed("returnTypes");
      }
    },
    // The Python pair (bd tea-rags-mcp-4yvms). No `markContributed`: neither is a
    // {@link RunGlobalMapName} — `buildResolverInputs` hands both to pass-2
    // unconditionally, so there is no per-file fallback for a flag to switch to.
    //
    // Batch-wins at the CLASS KEY, never merged field-by-field: the walked
    // extraction is the whole truth about that class, so a persisted row that
    // still lists a field the class has since dropped must not top it up.
    classFieldTypesByClassKey: (slice) => {
      for (const [classKey, fields] of Object.entries(slice.classFieldTypesByClassKey ?? {})) {
        if (classKey in this.classFieldTypesByClassKey) continue;
        this.classFieldTypesByClassKey[classKey] = fields;
      }
    },
    // Batch-wins on the DECLARING relPath, the grain `absorb` replaces this
    // channel at. Unreachable while `selectHydratablePass1Aggregates` drops walked
    // files, and kept so "the walked list is the whole truth about one file" is a
    // property of this merge, not of the filter upstream of it.
    moduleReexports: (slice) => {
      if (slice.moduleReexports !== undefined && !(slice.relPath in this.moduleReexports)) {
        this.moduleReexports[slice.relPath] = slice.moduleReexports;
      }
    },
  };

  /**
   * Did any file — or any barrier fold — contribute to this run-global map?
   * Equivalent to `Object.keys(this[name]).length > 0`: {@link markContributed}
   * fires per ENTRY WRITTEN, so a file declaring `classAncestors: {}` leaves it `false`.
   */
  hasRunGlobalEntries(name: RunGlobalMapName): boolean {
    return this.contributedRunGlobals[name];
  }

  /** Record that a map just received an entry. Call per write, not per field. */
  private markContributed(name: RunGlobalMapName): void {
    this.contributedRunGlobals[name] = true;
  }

  /**
   * Forget contributions for the maps a reset seam just emptied. Defaults to all
   * six; the seams clear DIFFERENT field sets — `drainMetrics`'s real-run branch
   * keeps four maps alive, and a flag cleared there would send pass-2 to the
   * per-file fallback while the run-global map still held facts.
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
   * Read the project's `Gemfile` ONCE per run (guarded) and forward the RAW
   * string to every `CallContext`; the parse lives in the resolver
   * (`catalogueForGemfile`). Absent / unreadable ⇒ `undefined` ⇒ FULL catalogue.
   * bd tea-rags-mcp-adx5p.1.
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
   * Walk the project's dependency manifests ONCE per run (guarded), so a framework
   * vocabulary is composed against what the project declares. The walk lives in
   * infra (the chunker worker needs it too); recognizing and parsing stay in
   * `domains/language`. No manifest ⇒ `undefined` ⇒ every vocabulary active.
   * bd tea-rags-mcp-w205u.1.
   */
  loadDeclaredDependencies(root: string): void {
    if (this.declaredDependenciesLoaded) return;
    this.declaredDependenciesLoaded = true;
    this.declaredDependencies = readDeclaredDependencies(root, this.dependencyManifestSources);
  }

  /**
   * Read every registered language's persisted-schema snapshot ONCE per run
   * (bd tea-rags-mcp-8l5fo), because the barrier (`seal`) where the pre-pass runs
   * never sees `root`. An absent or unreadable snapshot is a clean no-op.
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
   * Synthesize the persisted-schema column accessors onto their owning models and
   * publish them into the run's symbol table (bd tea-rags-mcp-8l5fo). Runs at the
   * barrier, where the ancestry map and the table overrides are first complete.
   * NOT persisted to `cg_symbols`: derived from a file outside the call graph and
   * rebuilt every run (lifecycle as `hierarchyView`).
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
   * Absorb the persisted pass-1 slices of files this run did NOT walk (bd
   * tea-rags-mcp-znxg8), so an incremental run's run-global maps describe the
   * PROJECT, matching the symbol table it resolves against.
   *
   *  - **Walked files are skipped, not merged.** Their row on disk still describes
   *    the previous content; absorbing it resurrects renamed-away classes.
   *  - **A hydrated key never displaces a walked one.** Hydration writes only into
   *    coordinates still empty.
   *  - **Nothing here counts as an extraction.** `extractedFilesByLanguage` and the
   *    path lists drive run stats and the deferred chunk pass.
   *
   * A read failure degrades to a batch-scoped registry with a stderr line rather
   * than aborting the run — losing the repair costs recall, losing the run costs
   * the index (same guard as the symbol-table hydration in `codegraph/factory.ts`).
   */
  private async hydratePersistedPass1Aggregates(
    load: () => Promise<readonly CodegraphPass1FileAggregates[]>,
  ): Promise<void> {
    let persisted: readonly CodegraphPass1FileAggregates[];
    try {
      persisted = await load();
    } catch (err) {
      process.stderr.write(
        `[tea-rags] codegraph pass-1 aggregate hydration failed: ${(err as Error).message}\n` +
          "[tea-rags] resolution continues against this run's batch only — entry calls into unchanged files may degrade\n",
      );
      return;
    }
    const walked = new Set<string>();
    for (const relPaths of this.extractedRelPathsByLanguage.values()) for (const p of relPaths) walked.add(p);
    const hydratable = selectHydratablePass1Aggregates(persisted, walked);
    if (hydratable.length === 0) return;

    // Which maps absorb a slice is `RUN_GLOBAL_MAP_PERSISTENCE`'s call, not this
    // loop's (bd tea-rags-mcp-39xca.6); each map writes only its own field, so
    // the registry order moves nothing but the iteration.
    for (const slice of hydratable) {
      for (const field of HYDRATED_RUN_GLOBAL_MAPS) this.pass1Hydrators[field](slice);
    }
    if (isDebug()) {
      console.error("[GitEnrich] PHASE: CODEGRAPH_PASS1_HYDRATED", {
        persistedRows: persisted.length,
        walkedFiles: walked.size,
        hydratedFiles: hydratable.length,
        selfDispatchMethods: this.selfDispatchMethods.length,
        inheritanceRows: this.inheritanceRows.length,
      });
    }
  }

  /**
   * Pass-1→pass-2 barrier (bd tea-rags-mcp-o17v2 + cai0/2oky5 + DEFECT 2): the
   * run-global maps are frozen, so build the hierarchy view and include-by index
   * ONCE, then discover the self-dispatch templates.
   *
   * Both loaders are lazy: `resolveSymbolTable` only for the branches that need
   * it, `loadPersistedPass1Aggregates` (bd tea-rags-mcp-znxg8) because it MUST be
   * absorbed FIRST — every product below is computed from the maps it feeds, and
   * taking it as a parameter makes that ordering this method's property.
   */
  async seal(
    resolveSymbolTable: () => Promise<GlobalSymbolTable>,
    loadPersistedPass1Aggregates?: () => Promise<readonly CodegraphPass1FileAggregates[]>,
  ): Promise<void> {
    // Pass-2 starts here, so a new run scope does too (bd tea-rags-mcp-39xca.6).
    this.beginRunScope();
    if (loadPersistedPass1Aggregates !== undefined) {
      await this.hydratePersistedPass1Aggregates(loadPersistedPass1Aggregates);
    }
    this.hierarchyView = new MapHierarchyView(buildHierarchySnapshot(this.inheritanceRows));
    this.includedBy = buildIncludedBy(this.ancestors, this.prependedAncestors);
    // Persisted-schema column accessors (bd tea-rags-mcp-8l5fo): only here are the
    // ancestry map (which classes are models) and the `self.table_name` overrides
    // both complete. The column VALUE types are held back and merged LAST (below).
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
      // Service-entry RETURN threading (bd tea-rags-mcp-j9xpf): the walker types
      // the SHARED template's return, call sites name a CONCRETE entry constant,
      // and only here are both the return facts and the wiring hierarchy complete.
      // Merged DERIVED-last: the helper skips coordinates already carrying a
      // declared fact, so YARD / associations / body-last-expr keep precedence.
      //
      // The existence oracle (bd tea-rags-mcp-yt3im) makes "declared wins"
      // checkable: a fact naming a type this run declares nowhere is an annotation
      // fiction and does not outrank a derivation.
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
    // Persisted-schema column VALUE types (bd tea-rags-mcp-2a5oo), merged LAST and
    // only where the coordinate is still empty: a column accessor has no `def`, so
    // ANY other fact at `Model#col` describes a real declaration that must win.
    for (const [key, ref] of Object.entries(schemaColumnReturnTypes)) {
      if (key in this.structuredReturnTypes) continue;
      // Barrier-derived but still a contribution: without the flag pass-2 falls
      // back to per-file maps that lack these.
      this.structuredReturnTypes[key] = ref;
      this.markContributed("structuredReturnTypes");
    }
    // Interprocedural PARAMETER typing, Increment 1 (bd tea-rags-mcp-bvalc): only
    // here is the method-definition index complete, so call-site candidates can be
    // gated against real defs. The fold consumes NO resolution result, which is
    // what lets it run before pass-2 instead of needing a fixpoint with it.
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
   * Clear the interprocedural parameter-typing run state (bd tea-rags-mcp-bvalc) —
   * accumulators AND barrier products — in one place, so a field added later
   * cannot be forgotten at one reset seam and leak into the next run.
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
      this.declaredDependencies = undefined;
      this.declaredDependenciesLoaded = false;
      this.projectRoot = undefined;
      this.prependedAncestors = {};
      this.classExtends = {};
      this.schemaTables = {};
      this.schemaSnapshots = {};
      this.schemaSnapshotsLoaded = false;
      this.returnTypes = {};
      this.instantiatedTypes.clear();
      this.ivarTypes = {};
      this.classFieldTypesByClassKey = {};
      this.classFieldCallResults = {};
      this.moduleReexports = {};
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
      this.beginRunScope();
      return undefined;
    }
    // tea-rags-mcp-ykj7 + cai0.2 (Option A) — the denominator excludes external,
    // dynamic-undeterminable, no-in-project-def and core-ambiguous calls: none can
    // resolve to an in-project symbol, so the rate equals inProjectEdgeRecall by
    // construction. `max(1, …)` guards a divide-by-zero when all were excluded.
    const internalAttempted = Math.max(
      1,
      callsAttempted - callsExternalSkipped - callsUnresolvable - callsNoInProjectDef - callsCoreAmbiguous,
    );
    const resolveSuccessRate = callsAttempted === 0 ? 0 : callsResolved / internalAttempted;
    // inProjectEdgeRecall — graph completeness: only residual misses WITH an
    // in-project def are true recall holes (no-in-project-def and core homonyms
    // through an untyped receiver, bd 83cl7, are excluded).
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
    // One-line per-idiom diagnostic (bd tea-rags-mcp-j431), once per enrichment
    // cycle, unconditional like the other `[codegraph]` diagnostics.
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
    this.declaredDependencies = undefined;
    this.declaredDependenciesLoaded = false;
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
    this.beginRunScope();
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
   * tea-rags-mcp-cnqrg, extends j431) to persistable rows. The client replaces
   * each named language's `cg_run_stats` rows so stale prior-run cells never
   * leak; a language absent from this run simply has no rows. The tally is NOT
   * reset here — `drainMetrics` owns read-and-clear.
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
          unnarrowedTemplate: t.unnarrowedTemplate,
        });
      }
    }
    return rows;
  }

  /**
   * The per-file tally as `cg_file_resolve_stats` entries (bd
   * tea-rags-mcp-xpmwg): one per file this run resolved, with a row per receiver
   * kind the file tallied a call under — none for a file without call sites.
   * Like {@link toResolveRunStatsRows}, reads without resetting.
   */
  toFileResolveStatsEntries(): FileResolveStatsEntry[] {
    return [...this.stats.byFile].map(([relPath, file]) => ({
      relPath,
      language: file.language,
      rows: [...file.kinds].map(([receiverKind, t]) => ({
        receiverKind,
        attempted: t.attempted,
        resolved: t.resolved,
        externalSkipped: t.externalSkipped,
        unresolvable: t.unresolvable,
        noInProjectDef: t.noInProjectDef,
        coreAmbiguous: t.coreAmbiguous,
        ambiguousFanout: t.ambiguousFanout,
        unnarrowedTemplate: t.unnarrowedTemplate,
      })),
    }));
  }

  /**
   * Zero the per-run resolve tally at a run-START seam. The provider instance is
   * cached and reused, so every run-start path must zero it, or a prior run whose
   * `drainMetrics` never fired leaks into this one (bd tea-rags-mcp-svhqp).
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
    this.declaredDependencies = undefined;
    this.declaredDependenciesLoaded = false;
    this.projectRoot = undefined;
    // bd tea-rags-mcp-weno4 — injected for ONE run against ONE collection.
    this.injectedPass1Aggregates = undefined;
    this.beginRunScope();
    this.prependedAncestors = {};
    this.includedBy = {};
    this.classExtends = {};
    this.schemaTables = {};
    this.schemaSnapshots = {};
    this.schemaSnapshotsLoaded = false;
    this.returnTypes = {};
    this.instantiatedTypes.clear();
    this.ivarTypes = {};
    this.classFieldTypesByClassKey = {};
    this.classFieldCallResults = {};
    this.moduleReexports = {};
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
    this.declaredDependencies = undefined;
    this.declaredDependenciesLoaded = false;
    this.projectRoot = undefined;
    // bd tea-rags-mcp-weno4 — injected for ONE run against ONE collection.
    this.injectedPass1Aggregates = undefined;
    this.beginRunScope();
    this.prependedAncestors = {};
    this.classExtends = {};
    this.schemaTables = {};
    this.schemaSnapshots = {};
    this.schemaSnapshotsLoaded = false;
    this.returnTypes = {};
    this.instantiatedTypes.clear();
    this.ivarTypes = {};
    this.classFieldTypesByClassKey = {};
    this.classFieldCallResults = {};
    this.moduleReexports = {};
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
    // Counted here, not beside `stats.extractedFiles` in the sink, because this is
    // a run-global aggregate the barrier reads. The defensive empty extraction
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
    // Explicit ORM table overrides (`self.table_name`), run-global so the barrier's
    // schema-column pre-pass sees every declaration (bd tea-rags-mcp-8l5fo).
    if (extraction.classSchemaTables) {
      for (const [k, v] of Object.entries(extraction.classSchemaTables)) {
        this.schemaTables[k] = v;
      }
    }
    // Function return types run-global, keyed by function name (bd
    // tea-rags-mcp-6g9c). Last write wins; the resolver's symbol-table existence
    // gate suppresses a wrong type that survives a name collision.
    if (extraction.functionReturnTypes) {
      for (const [k, v] of Object.entries(extraction.functionReturnTypes)) {
        this.returnTypes[k] = v;
        this.markContributed("returnTypes");
      }
    }
    // The Ruby type-source PRECISE maps, run-global and keyed by class, so the
    // precise `@ivar.method()` / structured-return paths see types regardless of
    // the declaring file. Last-write-wins, mirroring functionReturnTypes.
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
    // The class-key-addressed field channel, run-global (bd tea-rags-mcp-f0xaa).
    // The key already names the declaring file, so a union across files cannot
    // conflate two same-named classes and no language gate is needed — a walker
    // that never writes the channel contributes nothing.
    if (extraction.classFieldTypesByClassKey) {
      for (const [classKey, fields] of Object.entries(extraction.classFieldTypesByClassKey)) {
        this.classFieldTypesByClassKey[classKey] = { ...this.classFieldTypesByClassKey[classKey], ...fields };
      }
    }
    // Its call-assigned sibling (bd tea-rags-mcp-w205u, E4.6c) — same key, same
    // union, and the same reason no language gate is needed.
    if (extraction.classFieldCallResults) {
      for (const [classKey, fields] of Object.entries(extraction.classFieldCallResults)) {
        this.classFieldCallResults[classKey] = { ...this.classFieldCallResults[classKey], ...fields };
      }
    }
    // The file's `from` statements, verbatim under its own path (bd
    // tea-rags-mcp-xpl83.3). Assignment rather than union: a re-walk must not
    // resurrect a statement the file no longer has.
    if (extraction.moduleReexports) {
      this.moduleReexports[extraction.relPath] = extraction.moduleReexports;
    }
    // Program-wide instantiation set for the cone resolver's RTA pruning (bd
    // tea-rags-mcp-pffv), regardless of which file instantiates the type.
    if (extraction.instantiatedTypes) {
      for (const t of extraction.instantiatedTypes) {
        this.instantiatedTypes.add(t);
      }
    }
    // Dispatch tables run-global by table name + defining relPath (bd
    // tea-rags-mcp-n0zj). Re-walking a file replaces its own def for that name, so
    // an incremental reindex stays idempotent.
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
    // Interprocedural param typing, Increment 1 (bd tea-rags-mcp-bvalc): LIGHT
    // records only — deduped call-arg shapes, the positional param-name index,
    // `@ivar = <param>` links and the coordinates the walker already typed (the
    // derivation's gate). Ruby-only, like the consuming fold and resolver paths.
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
