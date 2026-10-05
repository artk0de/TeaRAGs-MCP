/**
 * Pass-2 per-file call resolution (bd tea-rags-mcp-6vfrj / G2).
 *
 * Reads one file's `FileExtraction` plus the now-complete symbol table, threads
 * the run-global maps into a `CallContext` per call site, and emits the file's
 * `GraphEdges` (file edges, method edges, inheritance rows, over-cap ambiguous
 * fan-out aggregates). Every resolve outcome is tallied back into
 * `CodegraphRunState.stats` — both the aggregate scalars and the
 * per-(language, receiver-kind) breakdown that `cg_run_stats` persists.
 *
 * Extracted verbatim from `CodegraphEnrichmentProvider#resolveExtraction`;
 * language capability still arrives ONLY through the injected
 * `LanguageFactoryDescriptor` (the leaf-domain guard forbids
 * `trajectory/** -> domains/language/**`).
 */

import { identifierEntry } from "../../../../contracts/identifier-record.js";
import {
  chunkCallerScope,
  type CallContext,
  type FileExtraction,
  type GlobalSymbolTable,
  type GraphEdges,
  type HierarchyView,
  type RelPath,
  type SymbolDefinitionKind,
} from "../../../../contracts/types/codegraph.js";
import type {
  LanguageCapability,
  LanguageFactoryDescriptor,
  LanguageSymbolResolver,
} from "../../../../contracts/types/language.js";
import { mergeDerivedClassFieldTypes, seedParamLocalBindings } from "./call-arg-param-types.js";
import { descendantNamesOf, HierarchyDependencyRecorder } from "./hierarchy-dependencies.js";
import { normalizeInheritanceEdges } from "./inheritance-edges.js";
import { buildPass1Aggregates } from "./pass1-aggregates.js";
import { classifyReceiverKind, type ReceiverKind } from "./receiver-kind.js";
import {
  buildIncludedBy,
  emptyReceiverKindTally,
  foldFileKindTally,
  type CodegraphRunState,
  type ReceiverKindTally,
} from "./run-state.js";
import { extractSelfDispatchMethods, SELF_DISPATCH_LANGUAGE } from "./self-dispatch-discovery.js";
import { lastSegment } from "./symbol-name.js";

type ChunkExtraction = FileExtraction["chunks"][number];
type CallRef = ChunkExtraction["calls"][number];
type MethodEdges = GraphEdges["methodEdges"];
type AmbiguousFanouts = NonNullable<GraphEdges["ambiguousFanouts"]>;

/** One language's pass-2 visit order (bd tea-rags-mcp-vtuu4) — see `CallEdgeResolutionRunner#resolveVisitPlans`. */
export interface CodegraphResolveVisitPlan {
  readonly language: string;
  /** Visited in order; files no group names are visited before the first. */
  readonly groups: readonly (readonly RelPath[])[];
  /** Pass-2 finished one group: tell the language's resolver. */
  readonly endGroup: () => void;
}

/**
 * The "run-global if any file contributed, else this file's own" selection,
 * resolved ONCE per file and reused for the file-edge context and every call
 * site's context.
 */
export interface ResolverInputs {
  ancestors: Record<string, readonly string[]> | undefined;
  prependedAncestors: Record<string, readonly string[]> | undefined;
  includedBy: Record<string, string[]>;
  classExtends: Record<string, string> | undefined;
  returnTypes: Record<string, string> | undefined;
  instantiatedTypes: Set<string>;
  ivarTypes: Record<string, Record<string, string>> | undefined;
  structuredReturnTypes: CallContext["structuredReturnTypes"];
  classFieldTypes: CallContext["classFieldTypes"];
  classFieldTypesByClassKey: CallContext["classFieldTypesByClassKey"];
  classFieldCallResults: CallContext["classFieldCallResults"];
  moduleReexports: CallContext["moduleReexports"];
  buildConstraintsByFile: CallContext["buildConstraintsByFile"];
  typeDeclarations: CallContext["typeDeclarations"];
  /** The run's identity (bd tea-rags-mcp-39xca.6) — always the run state's, never per file. */
  runScope: NonNullable<CallContext["runScope"]>;
}

/**
 * The run-global slice of a `CallContext`, built ONCE from {@link ResolverInputs}
 * and spread into BOTH constructions — the file-edge context and every call
 * site's — so a channel added to `ResolverInputs` reaches both or neither.
 *
 * Hand-copying the channels into two literals is what let
 * `classFieldTypesByClassKey` reach NEITHER between bd tea-rags-mcp-f0xaa and
 * bd tea-rags-mcp-w205u: the field was added, populated from run state, and
 * read by nothing in production while both measurement harnesses built it. The
 * file-edge literal carried a second, older asymmetry for the same reason —
 * `functionReturnTypes` and `instantiatedTypes` had never been copied into it,
 * inherited from the pre-`CallEdgeResolutionRunner` provider. One function is
 * the structural answer to both, and
 * `tests/.../resolution-runner-callcontext-channels.test.ts` pins it.
 */
export function resolverInputChannels(inputs: ResolverInputs): Partial<CallContext> {
  return {
    classFieldTypes: inputs.classFieldTypes,
    classAncestors: inputs.ancestors,
    classPrependedAncestors: inputs.prependedAncestors,
    includedBy: inputs.includedBy,
    classExtends: inputs.classExtends,
    functionReturnTypes: inputs.returnTypes,
    // bd tea-rags-mcp-pffv — the instantiation set drives RTA pruning of the CHA
    // cone. Empty ⇒ the cone keeps its full fan-out (the gate); the file-edge
    // context also carries no `hierarchy`, so there is no cone there to prune.
    instantiatedTypes: inputs.instantiatedTypes,
    // Ruby type-source PRECISE paths (Increment 1, Task 1.5) — these wire the
    // `ctx.ivarTypes` / `ctx.structuredReturnTypes` reads in `type-propagation.ts`.
    ivarTypes: inputs.ivarTypes,
    structuredReturnTypes: inputs.structuredReturnTypes,
    // bd tea-rags-mcp-f0xaa / w205u E4.6c — the two class-key field channels,
    // by TYPE and by assigning CALL. Absent ⇒ `pythonInheritedMemberType` stops
    // exactly where it did before either channel existed.
    classFieldTypesByClassKey: inputs.classFieldTypesByClassKey,
    classFieldCallResults: inputs.classFieldCallResults,
    // bd tea-rags-mcp-xpl83.3 — run-global re-export lists let the import mapper
    // walk past a package `__init__.py` that re-exports a name or a SUBMODULE
    // instead of declaring it. Empty ⇒ the mapper stops exactly where it did.
    moduleReexports: inputs.moduleReexports,
    // bd tea-rags-mcp-e6xx — Go's build-tag twin tie-breaker. Empty ⇒ twins stay
    // ambiguous, the pre-channel answer.
    buildConstraintsByFile: inputs.buildConstraintsByFile,
    // bd tea-rags-mcp-y99pg.1 — which files DECLARE a type and which only
    // re-open it. Empty ⇒ every declaration counts as the type, as before.
    typeDeclarations: inputs.typeDeclarations,
    // bd tea-rags-mcp-39xca.6 — resolver memos scope their entries to this
    // token rather than to the pooled symbol table's identity.
    runScope: inputs.runScope,
  };
}

/**
 * One call site as pass-2 sees it: the call, its chunk, the chunk's local
 * bindings AFTER barrier-derived parameter seeding (what the receiver-kind
 * classifier reads), and the full `CallContext` the resolver is handed.
 */
export interface ResolvableCallSite {
  chunk: ChunkExtraction;
  call: CallRef;
  localBindings: ChunkExtraction["localBindings"];
  ctx: CallContext;
}

/**
 * What one call site produced. `"ambiguous"` is distinct from `"unresolved"`:
 * an over-cap fan-out is NOT a genuine miss and must skip miss classification
 * (bd f2jsb / j0pki).
 */
type CallResolutionOutcome = "resolved" | "unresolved" | "ambiguous";

/**
 * Everything pass-2 decided about ONE call site, before any of it is counted
 * (bd tea-rags-mcp-c6xuu). {@link CallEdgeResolutionRunner#resolveCallSites}
 * folds it into the run stats; an offline harness folds it into its own
 * per-kind tally through the same {@link tallyCallSiteVerdict}, so the
 * dispatch-table fan, the additive `dispatchArgs` join and the
 * `unnarrowedTemplate` gate reach both by construction.
 */
export interface CallSiteVerdict {
  receiverKind: ReceiverKind;
  outcome: CallResolutionOutcome;
  /** The method edges this site pushed, in push order. Empty unless `resolved`. */
  edges: MethodEdges;
  /** The over-cap aggregate, present exactly when `outcome === "ambiguous"`. */
  ambiguousFanout?: AmbiguousFanouts[number];
  /** Resolved onto a shared self-dispatch entry rather than the concrete hook. */
  unnarrowedTemplate: boolean;
  /** The denominator bucket, present exactly when `outcome === "unresolved"`. */
  missBucket?: ResolveMissBucket;
}

/**
 * Fold one verdict into a per-receiver-kind tally — the per-kind half of the
 * runner's bookkeeping, shared with the offline harnesses. `missWithInProjectDef`
 * has no counter: it is the residual `getRunMetrics` derives by subtraction.
 */
export function tallyCallSiteVerdict(
  kindTally: Record<ReceiverKind, ReceiverKindTally>,
  verdict: CallSiteVerdict,
): void {
  const row = kindTally[verdict.receiverKind];
  row.attempted += 1;
  if (verdict.outcome === "ambiguous") {
    row.ambiguousFanout += 1;
    return;
  }
  if (verdict.outcome === "resolved") {
    row.resolved += 1;
    if (verdict.unnarrowedTemplate) row.unnarrowedTemplate += 1;
    return;
  }
  const bucket = verdict.missBucket;
  if (bucket !== undefined && bucket !== "missWithInProjectDef") row[bucket] += 1;
}

/**
 * Generic import→file-edge resolution: synthesise a "call-shaped" lookup per
 * import so the same resolver contract handles import-to-file resolution. Used
 * for every language whose `LanguageSymbolResolver` facade does NOT expose
 * `resolveFileEdges` — Go, Java, Rust and Bash, whose file graph comes purely
 * from explicit imports. TypeScript, JavaScript and Python override it with
 * their import→file mappers (`member` here is a filename, so a member-keyed
 * pass can answer it with an unrelated file), Ruby to add the Zeitwerk
 * constant channel and inheritance edges, and Swift — whose imports name
 * modules, never files — to derive them from its resolved calls.
 */
function defaultImportFileEdges(
  extraction: FileExtraction,
  resolver: LanguageSymbolResolver,
  ctx: CallContext,
): GraphEdges["fileEdges"] {
  const fileEdges: GraphEdges["fileEdges"] = [];
  for (const imp of extraction.imports) {
    const last = lastSegment(imp.importText);
    const target = resolver.resolve(
      { callText: imp.importText, receiver: last, member: last, startLine: imp.startLine },
      ctx,
    );
    if (target) {
      fileEdges.push({
        targetRelPath: target.targetRelPath,
        importText: imp.importText,
        ...(imp.importedExportNames ? { importedExportNames: imp.importedExportNames } : {}),
        ...(imp.reexportedExportNames ? { reexportedExportNames: imp.reexportedExportNames } : {}),
      });
    }
  }
  return fileEdges;
}

/** Union of two optional name lists, first-seen order; absent when both are. */
function unionExportNames(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a) return b && [...b];
  if (!b) return a;
  return [...new Set([...a, ...b])];
}

/**
 * One row per (source, target) pair is all `cg_symbols_edges_file` can hold —
 * its PRIMARY KEY is the pair, not the import statement. The first occurrence's
 * import text wins; the export names of EVERY occurrence are unioned onto it
 * (bd tea-rags-mcp-r8hme.2), since a default import and a named import of one
 * file are one edge that takes both.
 */
function dedupeFileEdgesByTarget(edges: GraphEdges["fileEdges"]): GraphEdges["fileEdges"] {
  const byTarget = new Map<string, GraphEdges["fileEdges"][number]>();
  for (const edge of edges) {
    const first = byTarget.get(edge.targetRelPath);
    if (!first) {
      byTarget.set(edge.targetRelPath, { ...edge });
      continue;
    }
    const imported = unionExportNames(first.importedExportNames, edge.importedExportNames);
    const reexported = unionExportNames(first.reexportedExportNames, edge.reexportedExportNames);
    if (imported) first.importedExportNames = imported;
    if (reexported) first.reexportedExportNames = reexported;
  }
  return [...byTarget.values()];
}

export class CallEdgeResolutionRunner {
  constructor(
    private readonly languageFactory: LanguageFactoryDescriptor,
    private readonly runState: CodegraphRunState,
  ) {}

  /**
   * The hierarchy the file {@link resolve} is resolving reads — a recorder over
   * the caller family's view, so the file's hierarchy dependencies are exactly
   * what its call sites asked (bd tea-rags-mcp-7t2ee). Absent outside
   * `resolve` (the harness entry {@link callSiteVerdicts}), where the plain
   * view is threaded.
   */
  private activeHierarchy: { relPath: RelPath; recorder: HierarchyDependencyRecorder } | undefined;

  /**
   * Recorded descendant answers per sealed view. Keyed by the view object, which
   * the barrier builds anew every run, so the memo cannot outlive its run.
   */
  private readonly descendantAnswers = new WeakMap<HierarchyView, Map<string, string[]>>();

  private descendantAnswer(view: HierarchyView, typeName: string): string[] {
    let perView = this.descendantAnswers.get(view);
    if (perView === undefined) {
      perView = new Map();
      this.descendantAnswers.set(view, perView);
    }
    let names = perView.get(typeName);
    if (names === undefined) {
      names = descendantNamesOf(view, typeName);
      perView.set(typeName, names);
    }
    return names;
  }

  /**
   * Tell every language whose files this pass will resolve how many of them
   * there are, before the first file is read (bd tea-rags-mcp-6aytq).
   *
   * Pass-1 counted them, so the volume is known at the barrier rather than
   * discovered mid-pass — which is the whole point: a resolver that primes a
   * run-scoped cache on a workload HEURISTIC pays per-call-site costs until
   * the heuristic concludes. TypeScript's warm-up gate is the measured case:
   * on a full taxdome run it spends 66 per-entry `ts.createProgram` builds,
   * 9-13 s, establishing what the file count already said.
   *
   * Advisory in both directions. Languages the factory does not support are
   * skipped (`create` throws for them), resolvers without the hook are a
   * no-op, and a resolver that primes and fails must fall back on its own —
   * nothing here inspects the outcome, because there is nothing this runner
   * would do differently either way.
   */
  prepareResolvePass(): void {
    const supported = new Set(this.languageFactory.supported());
    for (const [language, expectedFileCount] of this.runState.extractedFilesByLanguage) {
      if (!supported.has(language)) continue;
      const { resolver } = this.languageFactory.create(language);
      const expectedRelPaths = this.runState.extractedRelPathsByLanguage.get(language);
      const expectedCallSites = this.callSitesOf(expectedRelPaths);
      resolver?.prepareResolvePass?.({
        expectedFileCount,
        // The corpus itself, not only its size: a resolver priming a
        // whole-project cache has to build it over the files this pass will
        // ask for, and the project's own declared file set is a different one
        // (bd tea-rags-mcp-6aytq).
        expectedRelPaths,
        // Present only when some file has calls, so a plan with nothing to
        // count carries no empty map (bd tea-rags-mcp-vtuu4).
        ...(expectedCallSites.size > 0 ? { expectedCallSites } : {}),
        projectRoot: this.runState.projectRoot,
      });
    }
  }

  /** Pass-1's call-site counts for `relPaths`, files without calls omitted. */
  private callSitesOf(relPaths: readonly RelPath[] | undefined): Map<RelPath, number> {
    const counts = new Map<RelPath, number>();
    for (const relPath of relPaths ?? []) {
      const callSites = this.runState.extractedCallSitesByRelPath.get(relPath);
      if (callSites !== undefined) counts.set(relPath, callSites);
    }
    return counts;
  }

  /**
   * Each language's pass-2 visit order, for the languages whose resolver asks
   * for one (bd tea-rags-mcp-vtuu4) — read once, after
   * {@link prepareResolvePass}, which is what built the order. Empty when no
   * language asks, and pass-2 then streams its spill unchanged.
   *
   * `endGroup` forwards the group end to the language's resolver, so pass-2
   * never holds a resolver reference of its own.
   */
  resolveVisitPlans(): CodegraphResolveVisitPlan[] {
    const supported = new Set(this.languageFactory.supported());
    const plans: CodegraphResolveVisitPlan[] = [];
    for (const language of this.runState.extractedFilesByLanguage.keys()) {
      if (!supported.has(language)) continue;
      const { resolver } = this.languageFactory.create(language);
      const groups = resolver?.planResolveVisits?.();
      if (groups === undefined) continue;
      plans.push({
        language,
        groups,
        endGroup: (): void => {
          resolver?.endResolveVisitGroup?.();
        },
      });
    }
    return plans;
  }

  /**
   * What each language's run-scoped caches did, keyed by language — the block
   * the pass-2 progress line carries (bd tea-rags-mcp-6aytq).
   *
   * Opaque by construction. The runner does not know what a TypeScript
   * `ts.Program` observable means and must not learn: it collects whatever each
   * resolver chooses to report and hands it to the log. A language whose
   * resolver declares no `diagnostics` is simply absent, which reads correctly
   * as "nothing to say" rather than as an empty measurement.
   */
  resolverDiagnostics(): Record<string, Record<string, unknown>> {
    const supported = new Set(this.languageFactory.supported());
    const out: Record<string, Record<string, unknown>> = {};
    for (const language of this.runState.extractedFilesByLanguage.keys()) {
      if (!supported.has(language)) continue;
      const reported = this.languageFactory.create(language).resolver?.diagnostics?.();
      if (reported !== undefined) out[language] = reported;
    }
    return out;
  }

  /**
   * Resolver capability comes from the injected LanguageFactoryDescriptor (keyed
   * by language NAME) — each native provider carries its own `CallResolver`.
   * `create` throws for unregistered languages, so gate on `supported()` first
   * (the defensive empty extraction emits `language: ""`, never registered).
   */
  private resolverFor(language: string): LanguageSymbolResolver | undefined {
    return this.languageFactory.supported().includes(language)
      ? this.languageFactory.create(language).resolver
      : undefined;
  }

  /**
   * The kinds a call written in `language` can land on — its capability's
   * `symbolKindRoles.callee` (bd tea-rags-mcp-jqvbn) — for the miss
   * classifier's fallback lookup. `undefined` when the factory carries no
   * capabilities (a test double), which counts every kind as before.
   */
  private calleeKindsFor(language: string): ReadonlySet<SymbolDefinitionKind> | undefined {
    this.capabilities ??= this.languageFactory.capabilities?.() ?? new Map();
    return this.capabilities.get(language)?.codegraph.symbolKindRoles.callee;
  }

  private capabilities: ReadonlyMap<string, LanguageCapability> | undefined;

  resolve(extraction: FileExtraction, symbolTable: GlobalSymbolTable): GraphEdges {
    const resolver = this.resolverFor(extraction.language);
    const methodEdges: MethodEdges = [];
    // Over-cap ambiguous dispatch fan-outs (bd f2jsb / j0pki) — one aggregate
    // record per suppressed fan-out, persisted alongside this file's edges via
    // upsertFile (INSTEAD of m noise edges).
    const ambiguousFanouts: AmbiguousFanouts = [];
    if (!resolver) return { fileEdges: [], methodEdges };

    const inputs = this.buildResolverInputs(extraction);
    const view = this.runState.hierarchyViewFor(extraction.language);
    const recorder = view === undefined ? undefined : new HierarchyDependencyRecorder(view);
    this.activeHierarchy = recorder === undefined ? undefined : { relPath: extraction.relPath, recorder };
    try {
      // Call sites FIRST, file edges second (bd tea-rags-mcp-y99pg.38): a
      // language whose imports name no file derives its file graph from where
      // these calls land, so `resolveFileEdges` receives them.
      this.resolveMethodEdges(extraction, symbolTable, resolver, inputs, methodEdges, ambiguousFanouts);
    } finally {
      this.activeHierarchy = undefined;
    }
    const runtimeFileEdges = this.buildFileEdges(extraction, symbolTable, resolver, inputs, methodEdges);
    const typeOnlyFileEdges = this.buildTypeOnlyFileEdges(extraction, symbolTable, resolver, inputs, runtimeFileEdges);
    // bd tea-rags-mcp-89k7k.31: a type-only import is a compile-time
    // dependency, so its resolved edge joins the runtime file graph beside the
    // dedicated channel — same convention as a call-less re-export edge, it
    // reads callWeight 0 everywhere the file graph is aggregated (no method
    // edge can sit behind it), keeping fanIn / instability / blast radius
    // honest while the coupling it declares stays ranked below runtime ones.
    // Type-only edges are already filtered against runtime targets and
    // self-edges, so the concat stays unique per (source, target). Export
    // names ride along: a type-only import takes names off the target's
    // surface, and the facade-bypass check reads them off the file edge.
    const fileEdges = typeOnlyFileEdges.length > 0 ? [...runtimeFileEdges, ...typeOnlyFileEdges] : runtimeFileEdges;

    // Class hierarchy (bd tea-rags-mcp-f10y). Persist this file's declared
    // inheritance edges alongside its file/method edges so cg_symbols_inheritance
    // shares the per-file upsert lifecycle. Ancestor names resolve to in-project
    // symbol_ids via the now-complete symbol table (pass-1 done); external
    // ancestors keep ancestorSymbolId=null. Sources every language: TS via the
    // unified inheritanceEdges field, others via the legacy class* Records.
    const inheritance = normalizeInheritanceEdges(extraction, (fq) => symbolTable.lookup(fq)[0]?.symbolId ?? null);
    const edges: GraphEdges = { fileEdges, methodEdges };
    if (typeOnlyFileEdges.length > 0) {
      // The dedicated channel keeps its lean shape — its table has no export
      // name columns; the merged copy in `fileEdges` carries them.
      edges.typeOnlyFileEdges = typeOnlyFileEdges.map((e) => ({
        targetRelPath: e.targetRelPath,
        importText: e.importText,
      }));
    }
    if (inheritance.length > 0) edges.inheritance = inheritance;
    if (ambiguousFanouts.length > 0) edges.ambiguousFanouts = ambiguousFanouts;
    // What the call sites read from the hierarchy (bd tea-rags-mcp-7t2ee), so a
    // later run can re-resolve this file when one of those answers moves.
    if (view !== undefined && recorder !== undefined) {
      const dependencies = recorder.dependencies((typeName) => this.descendantAnswer(view, typeName));
      if (dependencies.length > 0) edges.hierarchyDependencies = dependencies;
    }
    // The pass-1 aggregate slice (bd tea-rags-mcp-znxg8), attached here so it
    // rides the per-file reconciliation the edges already have. Derived from the
    // SPILLED extraction rather than handed down from pass-1: pass-1 folds every
    // file's candidates into one run-global list that is no longer addressable
    // per file, and re-deriving from the chunks in hand is both cheaper than
    // keeping a parallel per-file index alive across the barrier and immune to
    // the two drifting apart.
    // A language whose resolver does not read `typeDeclarations` persists none
    // in the slice (bd tea-rags-mcp-vi0wx): hydration would put them back in
    // the run-global map the gate at `absorb` keeps them out of.
    const pass1Aggregates = buildPass1Aggregates(
      this.runState.readsTypeDeclarations(extraction.language)
        ? extraction
        : { ...extraction, typeDeclarations: undefined },
      extraction.language === SELF_DISPATCH_LANGUAGE ? extractSelfDispatchMethods(extraction.chunks) : [],
    );
    if (pass1Aggregates !== undefined) edges.pass1Aggregates = pass1Aggregates;
    return edges;
  }

  /**
   * Pick each resolver input run-global-first: the resolver must see ancestors,
   * return types and instantiations from the WHOLE run (the declaring file is
   * usually not the calling file), falling back to this file's own maps in
   * single-file / test mode.
   */
  private buildResolverInputs(extraction: FileExtraction): ResolverInputs {
    const state = this.runState;
    // Resolver receives the run-global `classAncestors` so it can walk
    // a bound type's inheritance chain regardless of which file
    // declares that class. Per-file ancestors are merged into
    // `runState.ancestors` during pass-1 (sink.write). Class names are shared
    // across languages, so every class-name map is read from the CALLER's
    // language family partition, never the all-family view (bd
    // tea-rags-mcp-nbf8q) — and so are the bare-name return maps and the
    // hierarchy view (bd tea-rags-mcp-qea83).
    const { language } = extraction;
    const ancestorsRunGlobal = state.hasRunGlobalEntries("ancestors");
    const prependedRunGlobal = state.hasRunGlobalEntries("prependedAncestors");
    const ancestors = ancestorsRunGlobal ? state.ancestorsFor(language) : extraction.classAncestors;
    const prependedAncestors = prependedRunGlobal
      ? state.prependedAncestorsFor(language)
      : extraction.classPrependedAncestors;
    // Reverse include-by index (bd cai0/2oky5 Task 4): find which classes include
    // a given module (`resolveViaIncludingClasses` in ruby-super.ts). When BOTH
    // ancestor inputs ARE the run-global maps (production pass-2) the inversion is
    // a run-global invariant — read the copy built ONCE at the pass-1→pass-2
    // barrier instead of recomputing it per file. The single-file / test fallback
    // (per-file extraction maps) still computes fresh, so the result is
    // byte-identical in every case.
    const includedBy =
      ancestorsRunGlobal && prependedRunGlobal
        ? state.includedByFor(language)
        : buildIncludedBy(ancestors ?? {}, prependedAncestors ?? {});
    return {
      ancestors,
      prependedAncestors,
      includedBy,
      classExtends: state.hasRunGlobalEntries("classExtends")
        ? state.classExtendsFor(language)
        : extraction.classExtends,
      returnTypes: state.hasRunGlobalEntries("returnTypes")
        ? state.returnTypesFor(language)
        : extraction.functionReturnTypes,
      // Run-global instantiation set if any file contributed, else this file's
      // own (mirrors the returnTypes "run-global if present else extraction"
      // pattern). bd tea-rags-mcp-pffv.
      instantiatedTypes:
        state.instantiatedTypes.size > 0 ? state.instantiatedTypes : new Set(extraction.instantiatedTypes ?? []),
      // Ruby type-source PRECISE maps (Increment 1, Task 1.5): run-global if any
      // file contributed, else this file's own — same "run-global if present else
      // extraction" pattern as ancestors / return types.
      ivarTypes: state.hasRunGlobalEntries("ivarTypes") ? state.ivarTypes : extraction.ivarTypes,
      structuredReturnTypes: state.hasRunGlobalEntries("structuredReturnTypes")
        ? state.structuredReturnTypesFor(language)
        : extraction.structuredReturnTypes,
      // `@ivar = <param>` fields completed at the barrier ride the file's OWN
      // classFieldTypes channel, overlaid UNDERNEATH it (bd tea-rags-mcp-bvalc).
      // Identity-returns when nothing was derived, so a non-Ruby run — or a
      // Ruby run where no parameter could be typed — is byte-identical.
      classFieldTypes: mergeDerivedClassFieldTypes(extraction.classFieldTypes, state.derivedClassFieldTypes),
      // Run-global, unconditionally: the key names the declaring file, so unlike
      // the short-name channel beside it there is nothing to fall back to per
      // file (bd tea-rags-mcp-f0xaa). A run whose walkers never wrote it hands
      // the resolver an empty map, which every reader treats as absent.
      classFieldTypesByClassKey: state.classFieldTypesByClassKey,
      // Its call-assigned sibling, run-global for the same reason (bd
      // tea-rags-mcp-w205u, E4.6c). Empty ⇒ the resolver's last field read is
      // skipped outright, which is the pre-channel path.
      classFieldCallResults: state.classFieldCallResults,
      // Run-global for the same reason (bd tea-rags-mcp-xpl83.3): the mapper is
      // asked about a package the CALLER does not own, so this file's own list
      // could never answer. An empty map reads as absent to its only reader.
      moduleReexports: state.moduleReexports,
      // Run-global for the same reason: a twin's constraint lives in ANOTHER
      // file of the package (bd tea-rags-mcp-e6xx).
      buildConstraintsByFile: state.buildConstraintsByFile,
      // Run-global for the same reason: a type's declaration and its re-openings
      // live in files the caller does not own (bd tea-rags-mcp-y99pg.1).
      typeDeclarations: state.typeDeclarations,
      runScope: state.runScope,
    };
  }

  /**
   * File-level edges. A resolver that implements `resolveFileEdges` owns its
   * language's full set of file-coupling channels (Ruby: require + Zeitwerk
   * constants + inheritance/mixins; TS / JS / Python: their import→file
   * mappers). Resolvers that don't fall back to the generic synthesised-call
   * import loop — Go, Java, Rust and Bash, whose file graph comes purely from
   * explicit imports.
   *
   * Both branches emit one candidate edge per IMPORT STATEMENT, so a file
   * importing the same target twice (default + named import of the same
   * module, e.g. `import Button from './Button'` alongside
   * `import type { ButtonProps } from './Button'`) yields two candidates for
   * one (source, target) pair. `cg_symbols_edges_file` has no room for two —
   * its PRIMARY KEY is (source, target) — and while the writer now collapses
   * such a pair itself (bd tea-rags-mcp-8l8d3; before that it aborted the whole
   * `upsertFilesBulk` transaction with a native FatalException and took the
   * daemon down mid-request, bd tea-rags-mcp-alew8), WHICH of the two survives
   * is a resolution question, not a storage one. Dedup HERE, once, after either
   * branch returns, rather than in each resolver: every
   * language's file graph funnels through this one return, and the schema's
   * uniqueness is a property of the EDGE, not of any one resolver's import
   * loop. First occurrence wins — the persisted row has room for one
   * `importText` regardless, so there is no lossless alternative to picking
   * one.
   */
  private buildFileEdges(
    extraction: FileExtraction,
    symbolTable: GlobalSymbolTable,
    resolver: LanguageSymbolResolver,
    inputs: ResolverInputs,
    resolvedMethodEdges: MethodEdges,
  ): GraphEdges["fileEdges"] {
    // An import flagged `typeOnly` (Python `if TYPE_CHECKING:`) loads nothing at
    // runtime, so the runtime file graph is built without it. The same object
    // is handed on when nothing is flagged — the common case, and the only one
    // for a language that derives file edges from more than its imports.
    const runtime = extraction.imports.some((imp) => imp.typeOnly)
      ? { ...extraction, imports: extraction.imports.filter((imp) => !imp.typeOnly) }
      : extraction;
    const fileEdgeCtx = this.fileEdgeContext(runtime, symbolTable, inputs);
    const candidates = resolver.resolveFileEdges
      ? resolver.resolveFileEdges(runtime, fileEdgeCtx, resolvedMethodEdges)
      : defaultImportFileEdges(runtime, resolver, fileEdgeCtx);
    return dedupeFileEdgesByTarget(candidates);
  }

  /**
   * The files this one reaches ONLY through type-only imports
   * (bd tea-rags-mcp-r8hme.12): the `typeOnlyImports` channel plus every
   * `imports[]` entry flagged `typeOnly`. That list is resolved by the very
   * import→file path the runtime list takes — handed to the same resolver as if
   * it were the file's imports — so a specifier maps to the same file either
   * way. A target a runtime import already reaches is dropped (the runtime edge
   * says more), and so is a self-edge. No resolved method edges are passed: a
   * language that derives file edges from calls would otherwise hand the
   * runtime answer back.
   *
   * Since bd tea-rags-mcp-89k7k.31 what comes back is ALSO merged into
   * `fileEdges` by `resolve` — a type-only import is a structural dependency —
   * while `GraphEdges.typeOnlyFileEdges` keeps its own copy for the co-change
   * reader; the return shape is the full file-edge one so export names survive
   * the merge.
   */
  private buildTypeOnlyFileEdges(
    extraction: FileExtraction,
    symbolTable: GlobalSymbolTable,
    resolver: LanguageSymbolResolver,
    inputs: ResolverInputs,
    runtimeFileEdges: GraphEdges["fileEdges"],
  ): GraphEdges["fileEdges"] {
    const typeOnlyImports = [
      ...extraction.imports.filter((imp) => imp.typeOnly),
      ...(extraction.typeOnlyImports ?? []),
    ];
    if (typeOnlyImports.length === 0) return [];
    const typeOnlyExtraction: FileExtraction = { ...extraction, imports: typeOnlyImports };
    const ctx = this.fileEdgeContext(typeOnlyExtraction, symbolTable, inputs);
    const candidates = resolver.resolveFileEdges
      ? resolver.resolveFileEdges(typeOnlyExtraction, ctx, [])
      : defaultImportFileEdges(typeOnlyExtraction, resolver, ctx);
    const runtimeTargets = new Set(runtimeFileEdges.map((e) => e.targetRelPath));
    return dedupeFileEdgesByTarget(candidates).filter(
      (e) => e.targetRelPath !== extraction.relPath && !runtimeTargets.has(e.targetRelPath),
    );
  }

  private fileEdgeContext(
    extraction: FileExtraction,
    symbolTable: GlobalSymbolTable,
    inputs: ResolverInputs,
  ): CallContext {
    return {
      ...resolverInputChannels(inputs),
      callerFile: extraction.relPath,
      callerScope: extraction.fileScope,
      imports: extraction.imports,
      symbolTable,
      associationTypes: extraction.associationTypes,
      gemfileContent: this.runState.gemfileContent,
      declaredDependencies: this.runState.declaredDependencies,
      projectRoot: this.runState.projectRoot,
    };
  }

  /**
   * Method-level edges from calls. Tracks the resolve success ratio so the run
   * metrics surface how many call sites the resolver couldn't pin to a target
   * (low ratio = lots of dynamic / external calls).
   *
   * bd tea-rags-mcp-cnqrg — the per-language tally bucket is resolved once per
   * file (`extraction.language` is constant across this file's chunks). Test
   * files never reach here (excluded upstream at extraction), so every call
   * counted is production code.
   *
   * bd tea-rags-mcp-xpmwg — calls are counted into a tally of THIS file, which
   * the `finally` folds into both the per-language totals and the per-file
   * entry `cg_file_resolve_stats` persists. The fold runs even if resolution
   * throws part-way, so the language totals keep every call they counted before.
   */
  private resolveMethodEdges(
    extraction: FileExtraction,
    symbolTable: GlobalSymbolTable,
    resolver: LanguageSymbolResolver,
    inputs: ResolverInputs,
    methodEdges: MethodEdges,
    ambiguousFanouts: AmbiguousFanouts,
  ): void {
    const { stats } = this.runState;
    const kindTally = emptyReceiverKindTally();
    try {
      this.resolveCallSites(extraction, symbolTable, resolver, inputs, methodEdges, ambiguousFanouts, kindTally);
    } finally {
      foldFileKindTally(stats, extraction.relPath, extraction.language, kindTally);
    }
  }

  /** The per-call-site loop of {@link resolveMethodEdges}, counting into `kindTally`. */
  private resolveCallSites(
    extraction: FileExtraction,
    symbolTable: GlobalSymbolTable,
    resolver: LanguageSymbolResolver,
    inputs: ResolverInputs,
    methodEdges: MethodEdges,
    ambiguousFanouts: AmbiguousFanouts,
    kindTally: Record<ReceiverKind, ReceiverKindTally>,
  ): void {
    const { stats } = this.runState;
    const calleeKinds = this.calleeKindsFor(extraction.language);
    this.forEachCallSite(extraction, symbolTable, inputs, (site) => {
      const verdict = this.judgeCallSite(site, resolver, symbolTable, calleeKinds);
      methodEdges.push(...verdict.edges);
      if (verdict.ambiguousFanout !== undefined) ambiguousFanouts.push(verdict.ambiguousFanout);
      tallyCallSiteVerdict(kindTally, verdict);
      stats.callsAttempted += 1;
      if (verdict.outcome === "ambiguous") {
        // Over-cap dynamic fan-out (bd f2jsb / j0pki): its own bucket — not a
        // genuine miss, not external. The miss classifiers must NOT count it.
        stats.callsAmbiguousFanout += 1;
        return;
      }
      if (verdict.outcome === "resolved") {
        stats.callsResolved += 1;
        return;
      }
      const bucket = verdict.missBucket;
      if (bucket === "unresolvable") stats.callsUnresolvable += 1;
      else if (bucket === "externalSkipped") stats.callsExternalSkipped += 1;
      else if (bucket === "noInProjectDef") stats.callsNoInProjectDef += 1;
      else if (bucket === "coreAmbiguous") stats.callsCoreAmbiguous += 1;
    });
  }

  /**
   * Resolve ONE call site and decide every counter it moves, without moving
   * any (bd tea-rags-mcp-c6xuu): the receiver kind, the three-way outcome, the
   * edges and over-cap aggregate it produced, the shared-template gate and the
   * miss bucket. The single decision both {@link resolveCallSites} and
   * {@link callSiteVerdicts} read.
   */
  private judgeCallSite(
    { chunk, call, localBindings, ctx }: ResolvableCallSite,
    resolver: LanguageSymbolResolver,
    symbolTable: GlobalSymbolTable,
    calleeKinds: ReadonlySet<SymbolDefinitionKind> | undefined,
  ): CallSiteVerdict {
    const receiverKind = classifyReceiverKind(call, localBindings);
    const edges: MethodEdges = [];
    const fanouts: AmbiguousFanouts = [];
    const outcome = this.dispatchCall(call, chunk, ctx, resolver, edges, fanouts);
    const verdict: CallSiteVerdict = { receiverKind, outcome, edges, unnarrowedTemplate: false };
    if (outcome === "ambiguous") verdict.ambiguousFanout = fanouts[0];
    else if (outcome === "resolved") {
      verdict.unnarrowedTemplate = this.landedOnSharedTemplate(edges, ctx, receiverKind);
    } else verdict.missBucket = classifyResolveMiss(call, ctx, resolver, symbolTable, calleeKinds);
    return verdict;
  }

  /**
   * Every call site of one file with the `CallContext` pass-2 resolves it
   * against AND the verdict it reaches there — the edges it pushes and every
   * counter it moves — decided by the SAME {@link judgeCallSite} {@link resolve}
   * runs, without touching the run stats.
   *
   * For offline harnesses that drive the production resolver site by site
   * (`scripts/codegraph-chain-tally.ts`). A harness that assembled its own
   * context drifted from this one each time a channel changed shape — most
   * recently when nbf8q / qea83 partitioned the class-name, return-type and
   * hierarchy channels by language family (bd tea-rags-mcp-pkfi7). A harness
   * that replayed the per-site routing drifted the same way: it skipped
   * dispatch-table sites, never replayed the additive `dispatchArgs` join and
   * had no `unnarrowedTemplate` gate (bd tea-rags-mcp-c6xuu). So the harness
   * asks the runner for both, and folds the verdicts with
   * {@link tallyCallSiteVerdict}. Empty for a language the factory has no
   * resolver for, as `resolve` emits no method edges there. Valid after
   * `CodegraphRunState#seal`, like `resolve`.
   */
  callSiteVerdicts(
    extraction: FileExtraction,
    symbolTable: GlobalSymbolTable,
  ): (ResolvableCallSite & { verdict: CallSiteVerdict })[] {
    const resolver = this.resolverFor(extraction.language);
    if (!resolver) return [];
    const out: (ResolvableCallSite & { verdict: CallSiteVerdict })[] = [];
    const calleeKinds = this.calleeKindsFor(extraction.language);
    this.forEachCallSite(extraction, symbolTable, this.buildResolverInputs(extraction), (site) => {
      out.push({ ...site, verdict: this.judgeCallSite(site, resolver, symbolTable, calleeKinds) });
    });
    return out;
  }

  /**
   * The one call-site walk {@link resolveCallSites} and {@link callSiteVerdicts}
   * share, so the context a harness reads cannot differ from the one production
   * resolves against.
   */
  private forEachCallSite(
    extraction: FileExtraction,
    symbolTable: GlobalSymbolTable,
    inputs: ResolverInputs,
    visit: (site: ResolvableCallSite) => void,
  ): void {
    for (const chunk of extraction.chunks) {
      // Barrier-derived parameter types enter the chunk's own binding map at the
      // def line — the coordinate a YARD `@param` occupies — so every reader
      // downstream, the receiver-kind classifier included, sees ONE kind of
      // fact (bd tea-rags-mcp-bvalc). Names YARD already bound are untouched.
      const localBindings = seedParamLocalBindings(
        chunk.localBindings,
        identifierEntry(this.runState.paramTypes, chunk.symbolId),
        chunk.startLine,
      );
      for (const call of chunk.calls) {
        visit({
          chunk,
          call,
          localBindings,
          ctx: this.buildCallContext(extraction, chunk, symbolTable, inputs, localBindings),
        });
      }
    }
  }

  /**
   * Did this call site's edges land on a SHARED self-dispatch entry node rather
   * than the concrete hook its constant receiver names (bd tea-rags-mcp-znxg8)?
   *
   * Both registries count, and the second is the one that matters in practice.
   * The field report's degraded edges all pointed at `KindOfService.call` — the
   * CLASS method, a `selfInstantiatingClassMethods` member. The template KEY for
   * that service idiom is the INSTANCE form `KindOfService#call`, so an
   * invariant written against `selfDispatchTemplates` alone would have measured
   * zero on the exact 200 edges that prompted it.
   *
   * Counts the call site ONCE however many edges it produced: a fan-out that
   * reaches a template is one call that failed to narrow, not several.
   *
   * CONSTANT receivers only (bd tea-rags-mcp-4vg1i). Entry narrowing is
   * receiver-anchored: `Const.member` narrows to `Const#hook` because `Const`
   * names the concrete type. Every other receiver idiom names no type the
   * strategy could have narrowed TO, so its edge to the shared method is the
   * honest answer, not a failure — a subtype calling the hook it INHERITS
   * (`bareCall`) most of all. Measured on taxdome: of 2507 counted call sites,
   * 649 (25.9%) carried a non-constant receiver — 433 bare, 108 dynamic, 84
   * chain, the rest scattered — so an ungated counter reported a quarter more
   * defects than exist, and the samples behind them were unrelated fan-outs
   * (`result.success` reaching three different `Result.success`) rather than
   * entry calls at all.
   *
   * The registries are Ruby-only and empty everywhere else, so the early return
   * keeps every other language's hot path untouched.
   */
  private landedOnSharedTemplate(siteEdges: MethodEdges, ctx: CallContext, receiverKind: ReceiverKind): boolean {
    if (receiverKind !== "constant") return false;
    const templates = ctx.selfDispatchTemplates;
    const entries = ctx.selfInstantiatingClassMethods;
    if (templates === undefined && entries === undefined) return false;
    for (const { targetSymbolId: target } of siteEdges) {
      if (target === null) continue;
      if (templates?.[target] !== undefined) return true;
      if (entries?.includes(target) === true) return true;
    }
    return false;
  }

  /** One call site's `CallContext` — per-chunk locals plus the run-global maps. */
  private buildCallContext(
    extraction: FileExtraction,
    chunk: ChunkExtraction,
    symbolTable: GlobalSymbolTable,
    inputs: ResolverInputs,
    localBindings: ChunkExtraction["localBindings"],
  ): CallContext {
    return {
      // Every run-global channel, threaded by construction rather than by hand
      // (bd tea-rags-mcp-w205u) — see {@link resolverInputChannels}.
      ...resolverInputChannels(inputs),
      callerFile: extraction.relPath,
      callerScope: chunkCallerScope(chunk),
      callerSymbolId: chunk.symbolId,
      imports: extraction.imports,
      symbolTable,
      associationTypes: extraction.associationTypes,
      localBindings,
      localCallBindings: chunk.localCallBindings,
      // bd tea-rags-mcp-z68v9 — per-chunk, never merged run-global: a local's
      // binding is meaningless outside the body that established it.
      callResultBindings: chunk.callResultBindings,
      compactDeclaredClasses: this.runState.compactClasses,
      gemfileContent: this.runState.gemfileContent,
      declaredDependencies: this.runState.declaredDependencies,
      projectRoot: this.runState.projectRoot,
      // bd tea-rags-mcp-n0zj — run-global dispatch tables + callback
      // params drive the resolver's fan-out / inter-proc join.
      dispatchTables: this.runState.dispatchTables,
      callbackParams: this.runState.callbackParams,
      // bd tea-rags-mcp-o17v2 — run-global class hierarchy drives CHA cone
      // devirtualization of a polymorphic typed receiver. Built at the
      // pass-1→pass-2 barrier; undefined ⇒ cone resolver no-ops. The caller's
      // language family's view, never the all-family one (bd tea-rags-mcp-qea83).
      // Inside `resolve` the file's recorder, which answers from the same view
      // and remembers what was asked (bd tea-rags-mcp-7t2ee).
      hierarchy:
        this.activeHierarchy?.relPath === extraction.relPath
          ? this.activeHierarchy.recorder
          : this.runState.hierarchyViewFor(extraction.language),
      // bd DEFECT 2 — run-global self-dispatch template map narrows an entry
      // `Const.member` to the concrete `Const#hook`. Empty ⇒ the Ruby entry
      // strategy CONTINUEs (no-op).
      selfDispatchTemplates: this.runState.selfDispatchTemplates,
      // bd DEFECT 2 v2 — self-instantiating class methods bridge a class entry
      // to the same-named instance template. Empty ⇒ v2 branch is a no-op.
      selfInstantiatingClassMethods: this.runState.selfInstantiatingClassMethods,
      // bd emazx — argument templates: the entry strategy composes the hook name
      // from the call site's literal. Empty ⇒ step 2d is a no-op.
      selfDispatchArgTemplates: this.runState.selfDispatchArgTemplates,
    };
  }

  /**
   * Route ONE call site through the resolver and push whatever edges it yields.
   * Three channels, in the order the pre-split code had them: explicit dispatch
   * tables, bounded inter-proc join via callback args, and the default
   * cone-then-exact chain.
   */
  private dispatchCall(
    call: CallRef,
    chunk: ChunkExtraction,
    ctx: CallContext,
    resolver: LanguageSymbolResolver,
    methodEdges: MethodEdges,
    ambiguousFanouts: AmbiguousFanouts,
  ): CallResolutionOutcome {
    let resolved = false;
    if (call.dispatch) {
      // Dispatch call: fan out to candidates instead of normal
      // resolution. `sourceSymbolId: null` ⇒ the caller chunk.
      const tableOutcome = resolver.resolveDispatch?.(call, ctx);
      for (const edge of tableOutcome?.kind === "edges" ? tableOutcome.edges : []) {
        methodEdges.push({
          sourceSymbolId: edge.sourceSymbolId ?? chunk.symbolId,
          targetSymbolId: edge.targetSymbolId,
          targetRelPath: edge.targetRelPath,
          callExpression: call.callText,
          edgeKind: edge.edgeKind,
          confidence: edge.confidence,
        });
        resolved = true;
      }
      return resolved ? "resolved" : "unresolved";
    }
    if (call.dispatchArgs && call.dispatchArgs.length > 0) {
      // Bounded inter-proc join: a dispatch candidate-set passed as a
      // callback argument fans out from the CALLEE (non-null sourceSymbolId
      // on the edge), additive to the normal callee edge.
      const target = resolver.resolve(call, ctx);
      if (target) {
        methodEdges.push({
          sourceSymbolId: chunk.symbolId,
          targetSymbolId: target.targetSymbolId,
          targetRelPath: target.targetRelPath,
          callExpression: call.callText,
        });
        resolved = true;
      }
      const argsOutcome = resolver.resolveDispatch?.(call, ctx);
      for (const edge of argsOutcome?.kind === "edges" ? argsOutcome.edges : []) {
        methodEdges.push({
          sourceSymbolId: edge.sourceSymbolId ?? chunk.symbolId,
          targetSymbolId: edge.targetSymbolId,
          targetRelPath: edge.targetRelPath,
          callExpression: call.callText,
          edgeKind: edge.edgeKind,
          confidence: edge.confidence,
        });
        resolved = true;
      }
      return resolved ? "resolved" : "unresolved";
    }
    // CHA cone fan-out FIRST (bd tea-rags-mcp-2jet): a polymorphic
    // receiver whose static type has subtypes overriding the member
    // expands to N `cone` (or one `poly-base`) edges, REPLACING the
    // single imprecise base edge the exact chain would emit. Returns `[]`
    // for every non-polymorphic call (and every other language, whose
    // resolveDispatch keys off call.dispatch only), so the exact `resolve`
    // path stays the default — external receivers never cone.
    const fanout = resolver.resolveDispatch?.(call, ctx);
    if (fanout?.kind === "ambiguous") {
      // Over-cap dynamic fan-out (bd f2jsb): NO edges, NO exact-chain
      // fallback — mirrors the pre-cap decisiveness of a non-empty
      // fan-out. bd j0pki (Task 3): record the aggregate; the caller bumps
      // the run-stats bucket and skips miss classification.
      ambiguousFanouts.push({
        sourceSymbolId: chunk.symbolId,
        callExpression: call.callText,
        member: fanout.member,
        candidateCount: fanout.candidateCount,
      });
      return "ambiguous";
    }
    if (fanout !== undefined && fanout.edges.length > 0) {
      for (const edge of fanout.edges) {
        methodEdges.push({
          sourceSymbolId: edge.sourceSymbolId ?? chunk.symbolId,
          targetSymbolId: edge.targetSymbolId,
          targetRelPath: edge.targetRelPath,
          callExpression: call.callText,
          edgeKind: edge.edgeKind,
          confidence: edge.confidence,
        });
        resolved = true;
      }
      return resolved ? "resolved" : "unresolved";
    }
    const target = resolver.resolve(call, ctx);
    if (target) {
      methodEdges.push({
        sourceSymbolId: chunk.symbolId,
        targetSymbolId: target.targetSymbolId,
        targetRelPath: target.targetRelPath,
        callExpression: call.callText,
      });
      resolved = true;
    }
    return resolved ? "resolved" : "unresolved";
  }
}

/**
 * Which denominator bucket an UNRESOLVED call belongs to — the decision half of
 * `CallEdgeResolutionRunner#classifyMiss`, exported so the offline harnesses
 * score misses through production's own ordering instead of a copy of it (the
 * `createPythonSymbolResolutionChain` precedent, bd tea-rags-mcp-3yxmy).
 *
 * `missWithInProjectDef` is the residual — the only bucket the rate charges as
 * a failure, and the only one with no counter of its own: `getRunMetrics`
 * derives it by subtraction.
 */
export type ResolveMissBucket =
  | "unresolvable"
  | "externalSkipped"
  | "noInProjectDef"
  | "coreAmbiguous"
  | "missWithInProjectDef";

/**
 * Order matters: `dynamicSend` is checked BEFORE `targetsExternalImport`
 * because `send` ∈ RUBY_KERNEL_BUILTINS, so the external classifier would
 * otherwise mis-bucket it as externalSkipped.
 */
export function classifyResolveMiss(
  call: CallRef,
  ctx: CallContext,
  resolver: LanguageSymbolResolver,
  symbolTable: GlobalSymbolTable,
  calleeKinds?: ReadonlySet<SymbolDefinitionKind>,
): ResolveMissBucket {
  // bd cai0 — a dynamic `send(var)` / `public_send(expr)` whose target is
  // statically undeterminable. NOT a resolver miss and NOT external — count it
  // as `unresolvable` (excluded from the denominator).
  if (call.dynamicSend === true) return "unresolvable";
  // tea-rags-mcp-ykj7 — the resolver could not pin this call AND classified it
  // as an external-library / runtime import. Counted separately (aggregate +
  // per-(language, receiver-kind)) so getRunMetrics excludes it from the
  // denominator and cg_run_stats persists the breakdown.
  if (resolver.targetsExternalImport?.(call, ctx) ?? false) return "externalSkipped";
  // Genuine miss whose member has NO in-project definition — it can never
  // produce an in-project edge (gem/core/runtime-generated/dynamic), so it is
  // excluded from the inProjectEdgeRecall denominator. A resolver that never
  // targets another language's files answers for itself (bd tea-rags-mcp-t5cji):
  // the table is polyglot, and a foreign namesake is no edge this call can have.
  // The fallback counts only the kinds the CALLING language can call
  // (`calleeKinds`, its capability's `symbolKindRoles.callee`, bd
  // tea-rags-mcp-jqvbn): a same-named type it cannot call is no such edge either.
  const declared =
    resolver.hasInProjectDefinition?.(call, ctx) ??
    symbolTable.lookupByShortName(call.member, { kinds: calleeKinds }).length > 0;
  if (!declared) return "noInProjectDef";
  // tea-rags-mcp-83cl7 — CORE HOMONYM. The member IS defined somewhere in the
  // project (the branch above did not fire), but it is a core / runtime name on
  // an UNTYPED receiver (`row.cells.each`), so the real callee is
  // Enumerable#each and the project def is a same-name coincidence. Placed
  // AFTER the two gates above so externalSkipped / noInProjectDef stay
  // byte-identical; only the residual missWithInProjectDef is carved.
  if (resolver.targetsCoreAmbiguousMember?.(call, ctx) ?? false) return "coreAmbiguous";
  return "missWithInProjectDef";
}
