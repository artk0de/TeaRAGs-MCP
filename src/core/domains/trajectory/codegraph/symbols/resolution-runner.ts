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

import type {
  CallContext,
  FileExtraction,
  GlobalSymbolTable,
  GraphEdges,
} from "../../../../contracts/types/codegraph.js";
import type { LanguageFactoryDescriptor, LanguageSymbolResolver } from "../../../../contracts/types/language.js";
import { mergeDerivedClassFieldTypes, seedParamLocalBindings } from "./call-arg-param-types.js";
import { normalizeInheritanceEdges } from "./inheritance-edges.js";
import { classifyReceiverKind, type ReceiverKind } from "./receiver-kind.js";
import { buildIncludedBy, languageKindTally, type CodegraphRunState, type ReceiverKindTally } from "./run-state.js";
import { lastSegment } from "./symbol-name.js";

type ChunkExtraction = FileExtraction["chunks"][number];
type CallRef = ChunkExtraction["calls"][number];
type MethodEdges = GraphEdges["methodEdges"];
type AmbiguousFanouts = NonNullable<GraphEdges["ambiguousFanouts"]>;

/**
 * The "run-global if any file contributed, else this file's own" selection,
 * resolved ONCE per file and reused for the file-edge context and every call
 * site's context.
 */
interface ResolverInputs {
  ancestors: Record<string, readonly string[]> | undefined;
  prependedAncestors: Record<string, readonly string[]> | undefined;
  includedBy: Record<string, string[]>;
  classExtends: Record<string, string> | undefined;
  returnTypes: Record<string, string> | undefined;
  instantiatedTypes: Set<string>;
  ivarTypes: Record<string, Record<string, string>> | undefined;
  structuredReturnTypes: CallContext["structuredReturnTypes"];
  classFieldTypes: CallContext["classFieldTypes"];
}

/**
 * What one call site produced. `"ambiguous"` is distinct from `"unresolved"`:
 * an over-cap fan-out is NOT a genuine miss and must skip miss classification
 * (bd f2jsb / j0pki).
 */
type CallResolutionOutcome = "resolved" | "unresolved" | "ambiguous";

/**
 * Generic import→file-edge resolution: synthesise a "call-shaped" lookup per
 * import so the same resolver contract handles import-to-file resolution. Used
 * for every language whose `CallResolver` does NOT implement `resolveFileEdges`
 * (TS/Python/Go/Java/Rust/JS) — their file graph comes purely from explicit
 * imports. Ruby overrides this via `resolveFileEdges` to add the Zeitwerk
 * constant channel and inheritance edges.
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
      fileEdges.push({ targetRelPath: target.targetRelPath, importText: imp.importText });
    }
  }
  return fileEdges;
}

/**
 * One row per (source, target) pair is all `cg_symbols_edges_file` can hold —
 * its PRIMARY KEY is the pair, not the import statement. First occurrence
 * wins; later duplicates carry no information the schema has room for.
 */
function dedupeFileEdgesByTarget(edges: GraphEdges["fileEdges"]): GraphEdges["fileEdges"] {
  const seen = new Set<string>();
  const deduped: GraphEdges["fileEdges"] = [];
  for (const edge of edges) {
    if (seen.has(edge.targetRelPath)) continue;
    seen.add(edge.targetRelPath);
    deduped.push(edge);
  }
  return deduped;
}

export class CallEdgeResolutionRunner {
  constructor(
    private readonly languageFactory: LanguageFactoryDescriptor,
    private readonly runState: CodegraphRunState,
  ) {}

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
      resolver?.prepareResolvePass?.({ expectedFileCount, projectRoot: this.runState.projectRoot });
    }
  }

  resolve(extraction: FileExtraction, symbolTable: GlobalSymbolTable): GraphEdges {
    // Resolver capability comes from the injected LanguageFactoryDescriptor (keyed by
    // language NAME) — each native provider carries its own `CallResolver`.
    // `create` throws for unregistered languages, so gate on `supported()` first
    // (the defensive empty extraction emits `language: ""`, never registered).
    const resolver = this.languageFactory.supported().includes(extraction.language)
      ? this.languageFactory.create(extraction.language).resolver
      : undefined;
    const methodEdges: MethodEdges = [];
    // Over-cap ambiguous dispatch fan-outs (bd f2jsb / j0pki) — one aggregate
    // record per suppressed fan-out, persisted alongside this file's edges via
    // upsertFile (INSTEAD of m noise edges).
    const ambiguousFanouts: AmbiguousFanouts = [];
    if (!resolver) return { fileEdges: [], methodEdges };

    const inputs = this.buildResolverInputs(extraction);
    const fileEdges = this.buildFileEdges(extraction, symbolTable, resolver, inputs);
    this.resolveMethodEdges(extraction, symbolTable, resolver, inputs, methodEdges, ambiguousFanouts);

    // Class hierarchy (bd tea-rags-mcp-f10y). Persist this file's declared
    // inheritance edges alongside its file/method edges so cg_symbols_inheritance
    // shares the per-file upsert lifecycle. Ancestor names resolve to in-project
    // symbol_ids via the now-complete symbol table (pass-1 done); external
    // ancestors keep ancestorSymbolId=null. Sources every language: TS via the
    // unified inheritanceEdges field, others via the legacy class* Records.
    const inheritance = normalizeInheritanceEdges(extraction, (fq) => symbolTable.lookup(fq)[0]?.symbolId ?? null);
    const edges: GraphEdges = { fileEdges, methodEdges };
    if (inheritance.length > 0) edges.inheritance = inheritance;
    if (ambiguousFanouts.length > 0) edges.ambiguousFanouts = ambiguousFanouts;
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
    // `runState.ancestors` during pass-1 (sink.write).
    const ancestors = state.hasRunGlobalEntries("ancestors") ? state.ancestors : extraction.classAncestors;
    const prependedAncestors = state.hasRunGlobalEntries("prependedAncestors")
      ? state.prependedAncestors
      : extraction.classPrependedAncestors;
    // Reverse include-by index (bd cai0/2oky5 Task 4): find which classes include
    // a given module (`resolveViaIncludingClasses` in ruby-super.ts). When BOTH
    // ancestor inputs ARE the run-global maps (production pass-2) the inversion is
    // a run-global invariant — read the copy built ONCE at the pass-1→pass-2
    // barrier instead of recomputing it per file. The single-file / test fallback
    // (per-file extraction maps) still computes fresh, so the result is
    // byte-identical in every case.
    const includedBy =
      ancestors === state.ancestors && prependedAncestors === state.prependedAncestors
        ? state.includedBy
        : buildIncludedBy(ancestors ?? {}, prependedAncestors ?? {});
    return {
      ancestors,
      prependedAncestors,
      includedBy,
      classExtends: state.hasRunGlobalEntries("classExtends") ? state.classExtends : extraction.classExtends,
      returnTypes: state.hasRunGlobalEntries("returnTypes") ? state.returnTypes : extraction.functionReturnTypes,
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
        ? state.structuredReturnTypes
        : extraction.structuredReturnTypes,
      // `@ivar = <param>` fields completed at the barrier ride the file's OWN
      // classFieldTypes channel, overlaid UNDERNEATH it (bd tea-rags-mcp-bvalc).
      // Identity-returns when nothing was derived, so a non-Ruby run — or a
      // Ruby run where no parameter could be typed — is byte-identical.
      classFieldTypes: mergeDerivedClassFieldTypes(extraction.classFieldTypes, state.derivedClassFieldTypes),
    };
  }

  /**
   * File-level edges. A resolver that implements `resolveFileEdges` owns its
   * language's full set of file-coupling channels (Ruby: require + Zeitwerk
   * constants + inheritance/mixins). Resolvers that don't fall back to the
   * generic synthesised-call import loop — correct for languages whose file
   * graph comes purely from explicit imports (TS/Python/Go/Java/Rust/JS).
   *
   * Both branches emit one candidate edge per IMPORT STATEMENT, so a file
   * importing the same target twice (default + named import of the same
   * module, e.g. `import Button from './Button'` alongside
   * `import type { ButtonProps } from './Button'`) yields two candidates for
   * one (source, target) pair. `cg_symbols_edges_file` has no room for two —
   * its PRIMARY KEY is (source, target) — and DuckDB does not reject the
   * second row gracefully: it aborts the whole `upsertFilesBulk` transaction
   * with a native FatalException, taking the daemon process down mid-request
   * (bd tea-rags-mcp-alew8, root-caused live against taxdome). Dedup HERE,
   * once, after either branch returns, rather than in each resolver: every
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
  ): GraphEdges["fileEdges"] {
    const fileEdgeCtx: CallContext = {
      callerFile: extraction.relPath,
      callerScope: extraction.fileScope,
      imports: extraction.imports,
      symbolTable,
      classFieldTypes: inputs.classFieldTypes,
      associationTypes: extraction.associationTypes,
      classAncestors: inputs.ancestors,
      classPrependedAncestors: inputs.prependedAncestors,
      includedBy: inputs.includedBy,
      classExtends: inputs.classExtends,
      ivarTypes: inputs.ivarTypes,
      structuredReturnTypes: inputs.structuredReturnTypes,
      gemfileContent: this.runState.gemfileContent,
      projectRoot: this.runState.projectRoot,
    };
    const candidates = resolver.resolveFileEdges
      ? resolver.resolveFileEdges(extraction, fileEdgeCtx)
      : defaultImportFileEdges(extraction, resolver, fileEdgeCtx);
    return dedupeFileEdgesByTarget(candidates);
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
    const kindTally = languageKindTally(stats, extraction.language);
    for (const chunk of extraction.chunks) {
      // Barrier-derived parameter types enter the chunk's own binding map at the
      // def line — the coordinate a YARD `@param` occupies — so every reader
      // downstream, the receiver-kind classifier included, sees ONE kind of
      // fact (bd tea-rags-mcp-bvalc). Names YARD already bound are untouched.
      const localBindings = seedParamLocalBindings(
        chunk.localBindings,
        this.runState.paramTypes[chunk.symbolId],
        chunk.startLine,
      );
      for (const call of chunk.calls) {
        stats.callsAttempted += 1;
        const receiverKind = classifyReceiverKind(call, localBindings);
        kindTally[receiverKind].attempted += 1;
        const ctx = this.buildCallContext(extraction, chunk, symbolTable, inputs, localBindings);
        const outcome = this.dispatchCall(call, chunk, ctx, resolver, methodEdges, ambiguousFanouts);
        if (outcome === "ambiguous") {
          // Over-cap dynamic fan-out (bd f2jsb / j0pki): its own bucket — not a
          // genuine miss, not external. The miss classifiers must NOT count it.
          stats.callsAmbiguousFanout += 1;
          kindTally[receiverKind].ambiguousFanout += 1;
          continue;
        }
        if (outcome === "resolved") {
          stats.callsResolved += 1;
          kindTally[receiverKind].resolved += 1;
          continue;
        }
        this.classifyMiss(call, ctx, resolver, symbolTable, kindTally, receiverKind);
      }
    }
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
      callerFile: extraction.relPath,
      callerScope: chunk.scope,
      callerSymbolId: chunk.symbolId,
      imports: extraction.imports,
      symbolTable,
      classFieldTypes: inputs.classFieldTypes,
      associationTypes: extraction.associationTypes,
      localBindings,
      localCallBindings: chunk.localCallBindings,
      functionReturnTypes: inputs.returnTypes,
      // Ruby type-source PRECISE paths (Increment 1, Task 1.5) — these wire
      // the previously-dead `ctx.ivarTypes` / `ctx.structuredReturnTypes`
      // reads in `type-propagation.ts`.
      ivarTypes: inputs.ivarTypes,
      structuredReturnTypes: inputs.structuredReturnTypes,
      classAncestors: inputs.ancestors,
      compactDeclaredClasses: this.runState.compactClasses,
      gemfileContent: this.runState.gemfileContent,
      projectRoot: this.runState.projectRoot,
      classPrependedAncestors: inputs.prependedAncestors,
      includedBy: inputs.includedBy,
      classExtends: inputs.classExtends,
      // bd tea-rags-mcp-n0zj — run-global dispatch tables + callback
      // params drive the resolver's fan-out / inter-proc join.
      dispatchTables: this.runState.dispatchTables,
      callbackParams: this.runState.callbackParams,
      // bd tea-rags-mcp-o17v2 — run-global class hierarchy drives CHA cone
      // devirtualization of a polymorphic typed receiver. Built at the
      // pass-1→pass-2 barrier; undefined ⇒ cone resolver no-ops.
      hierarchy: this.runState.hierarchyView,
      // bd tea-rags-mcp-pffv — run-global instantiation set drives RTA
      // pruning of the CHA cone. Empty ⇒ cone keeps full fan-out (gate).
      instantiatedTypes: inputs.instantiatedTypes,
      // bd DEFECT 2 — run-global self-dispatch template map narrows an entry
      // `Const.member` to the concrete `Const#hook`. Empty ⇒ the Ruby entry
      // strategy CONTINUEs (no-op).
      selfDispatchTemplates: this.runState.selfDispatchTemplates,
      // bd DEFECT 2 v2 — self-instantiating class methods bridge a class entry
      // to the same-named instance template. Empty ⇒ v2 branch is a no-op.
      selfInstantiatingClassMethods: this.runState.selfInstantiatingClassMethods,
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

  /**
   * Bucket an unresolved call. Order matters: `dynamicSend` is checked BEFORE
   * `targetsExternalImport` because `send` ∈ RUBY_KERNEL_BUILTINS, so the
   * external classifier would otherwise mis-bucket it as externalSkipped.
   */
  private classifyMiss(
    call: CallRef,
    ctx: CallContext,
    resolver: LanguageSymbolResolver,
    symbolTable: GlobalSymbolTable,
    kindTally: Record<ReceiverKind, ReceiverKindTally>,
    receiverKind: ReceiverKind,
  ): void {
    const { stats } = this.runState;
    if (call.dynamicSend === true) {
      // bd cai0 — a dynamic `send(var)` / `public_send(expr)` whose target
      // is statically undeterminable. NOT a resolver miss and NOT external —
      // count it as `unresolvable` (excluded from the denominator).
      stats.callsUnresolvable += 1;
      kindTally[receiverKind].unresolvable += 1;
      return;
    }
    if (resolver.targetsExternalImport?.(call, ctx) ?? false) {
      // tea-rags-mcp-ykj7 — the resolver could not pin this call AND
      // classified it as an external-library / runtime import. Count it
      // separately (aggregate + per-(language, receiver-kind)) so
      // getRunMetrics excludes it from the denominator and cg_run_stats
      // persists the breakdown.
      stats.callsExternalSkipped += 1;
      kindTally[receiverKind].externalSkipped += 1;
      return;
    }
    if (symbolTable.lookupByShortName(call.member).length === 0) {
      // Genuine miss whose member has NO in-project definition — it can
      // never produce an in-project edge (gem/core/runtime-generated/
      // dynamic), so it is excluded from the inProjectEdgeRecall
      // denominator. The complement (miss WITH an in-project def) is the
      // true recall hole, derived in getRunMetrics.
      stats.callsNoInProjectDef += 1;
      kindTally[receiverKind].noInProjectDef += 1;
      return;
    }
    if (resolver.targetsCoreAmbiguousMember?.(call, ctx) ?? false) {
      // tea-rags-mcp-83cl7 — CORE HOMONYM. The member IS defined somewhere
      // in the project (the branch above did not fire), but it is a core /
      // runtime name on an UNTYPED receiver (`row.cells.each`), so the real
      // callee is Enumerable#each and the project def is a same-name
      // coincidence. Counted here rather than as a recall hole it can never
      // be — the mirror of the ykj7 external skip, one branch later. Placed
      // AFTER the two gates above so externalSkipped / noInProjectDef stay
      // byte-identical; only the residual missWithInProjectDef is carved.
      stats.callsCoreAmbiguous += 1;
      kindTally[receiverKind].coreAmbiguous += 1;
    }
  }
}
