/**
 * TypeScript implementation of the `CallResolver` contract.
 *
 * `resolve` runs an ordered chain of single-purpose `SymbolResolutionStrategy`
 * passes (see `./strategies/`) via the shared `resolveViaChain` engine. The
 * array order encodes precedence, and the three-state outcome
 * (resolved / drop / continue) makes the load-bearing guard drops explicit —
 * e.g. `super` without `classExtends` DROPS rather than falling through to a
 * same-file lookup that would emit a self-loop edge (bd tea-rags-mcp-4rgg).
 *
 * The pass order (each `name` in parens):
 *   1. super (super.X via classExtends — terminal guard)
 *   2. thisMember (this.X same-file)
 *   3. fieldType (this.field.X via declared field type)
 *   4. localBinding (param.X via walker-bound type — unambiguous local wins)
 *   5. namedImport (receiver ∈ import { … } importedNames — exact)
 *   6. importBasename (kebab→Pascal basename fallback)
 *   7. receiverSymbol (imported-files ∩ receiver-declaring-files)
 *   8. sameFile (caller-file-local definition wins over global ambiguity)
 *   9. globalShortName (global short-name lookup)
 *  10. importNarrowedFallback (narrow ambiguous N>1 by caller's imports)
 *  11. typeCheckerJsxComponent (ts.Program/typeChecker — JSX component tags)
 *  12. typeCheckerReturnType (ts.Program/typeChecker — receiver typed by a
 *      call's inferred return type, bd tea-rags-mcp-l3uob)
 *  13. typeCheckerFallback (ts.Program/typeChecker — generics + overloads)
 *  14. structuralTyping (ts.Program/typeChecker — duck typing + interface merging)
 *
 * Passes 11-14 are the only ones that read type information rather than AST
 * shape, and the only ones that touch the file system on the resolve path. They
 * run last by construction: everything above them is cheaper, so the checker is
 * consulted only for calls nothing else could decide, and they share ONE
 * `TSProgramCache` so a file is never typed twice. `CODEGRAPH_TS_TYPECHECKER=0`
 * removes all four from the chain entirely (bd tea-rags-mcp-uclbn).
 *
 * Pass 11 sits first because it answers a disjoint question and its gate is a
 * single flag read: a JSX tag site (`call.jsx`) is never a `CallExpression`,
 * so none of 12-14 could resolve it anyway (bd tea-rags-mcp-b4pvp). Among
 * 12-14 the relative order is a precision question, not a cost one — all
 * three share the Program, so nothing is saved by reordering them, but
 * getting the order wrong hides a call from the pass that should have
 * answered it:
 *   - 12 gates on a narrow receiver shape (typed by ANOTHER call's inferred
 *     return, no explicit annotation) and pins the receiver TYPE before
 *     reading the member off it, while 13's `getResolvedSignature` answers a
 *     superset of shapes from the call's own resolved signature alone —
 *     behind 13, pass 12 would never see a call (bd tea-rags-mcp-l3uob).
 *   - 14 follows 13 because `getResolvedSignature` picks the overload the
 *     ARGUMENTS select, which is the sharper answer whenever it applies; 14
 *     then handles the receivers that have no name to look up at all
 *     (bd tea-rags-mcp-icmnr).
 *
 * `resolveDispatch` is a separate fan-out contract (lookup-table dispatch, bd
 * tea-rags-mcp-n0zj) and stays in the orchestrator — it is not part of the
 * single-target resolution chain.
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type DispatchEdge,
  type DispatchFanoutOutcome,
  type DispatchRef,
  type DispatchTable,
  type DispatchTableDef,
  type SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type { SymbolResolutionStrategy } from "../../../../contracts/types/language.js";
import { ConeDispatchResolver } from "../../cone-dispatch.js";
import { resolveViaChain } from "../../resolver-chain.js";
import {
  collectImportedFiles,
  CONE_MAX_DEFAULT,
  TSConeTypeLocator,
  TSFieldTypeSymbolResolutionStrategy,
  TSGlobalShortNameSymbolResolutionStrategy,
  TSImportBasenameSymbolResolutionStrategy,
  TSImportNarrowedFallbackSymbolResolutionStrategy,
  TSLocalBindingSymbolResolutionStrategy,
  TSNamedImportSymbolResolutionStrategy,
  TSReceiverSymbolSymbolResolutionStrategy,
  TSSameFileSymbolResolutionStrategy,
  TSStructuralTypingSymbolResolutionStrategy,
  TSSuperSymbolResolutionStrategy,
  TSThisMemberSymbolResolutionStrategy,
  TSTypeCheckerFallbackSymbolResolutionStrategy,
  TSTypeCheckerJsxComponentSymbolResolutionStrategy,
  TSTypeCheckerReturnTypeInferenceSymbolResolutionStrategy,
  TSTypeCheckerUnionReceiverDispatchResolver,
  type ResolverConfig,
} from "./strategies/index.js";
import { targetsExternalImport } from "./ts-external-call.js";
import type { TsCompilerOptions } from "./ts-path-mapper.js";
import { TSProgramCache } from "./ts-program-cache.js";

/** Parse `CODEGRAPH_TS_CONE_MAX`; fall back to the TS default on absent/invalid. */
function resolveConeMax(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : CONE_MAX_DEFAULT;
}

/**
 * Is the typeChecker fallback pass enabled? On by default — it is the only pass
 * that can resolve the generic / overload cases at all. `CODEGRAPH_TS_TYPECHECKER=0`
 * (or `false`) is the kill switch for an environment where the extra file reads
 * on the resolve path are unwelcome; disabled, the pass is never constructed,
 * so no Program is ever built (bd tea-rags-mcp-uclbn).
 */
function typeCheckerFallbackEnabled(raw: string | undefined): boolean {
  return raw !== "0" && raw !== "false";
}

export class TSCallResolver implements CallResolver {
  readonly language = "typescript";
  private readonly strategies: SymbolResolutionStrategy[];
  private readonly cone: ConeDispatchResolver;

  /**
   * Program cache backing the typeChecker fallback pass. Exposed so a later
   * pass built on the same machinery (union narrowing, structural typing)
   * shares ONE cache rather than building a second set of Programs, and so a
   * caller owning a run boundary can `reset()` it. `null` when the fallback is
   * disabled.
   */
  readonly programCache: TSProgramCache | null;

  /**
   * Union / guard-narrowed receiver fan-out (bd tea-rags-mcp-3yj7d). A dispatch
   * component rather than a chain pass because its answer is N edges with a
   * confidence split, which the single-target strategy contract cannot carry.
   * `null` whenever the type checker is disabled — it shares `programCache`.
   */
  private readonly unionReceiver: TSTypeCheckerUnionReceiverDispatchResolver | null;

  /**
   * @param repoRoot Absolute project root the typeChecker fallback resolves
   *   `RelPath`s against. Defaults to `process.cwd()`, mirroring the
   *   `loadTsConfig(process.cwd())` the composition root already passes for
   *   `tsOptions`. A root that does not match the indexed project simply finds
   *   no files, and the fallback declines every call — it never guesses.
   */
  constructor(
    private readonly tsOptions: TsCompilerOptions,
    private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE,
    repoRoot: string = process.cwd(),
  ) {
    const cfg: ResolverConfig = { tsOptions, mode, coneMax: resolveConeMax(process.env.CODEGRAPH_TS_CONE_MAX) };
    this.cone = new ConeDispatchResolver(new TSConeTypeLocator(cfg), cfg.coneMax ?? CONE_MAX_DEFAULT);
    this.programCache = typeCheckerFallbackEnabled(process.env.CODEGRAPH_TS_TYPECHECKER)
      ? new TSProgramCache({ repoRoot, tsOptions })
      : null;
    this.unionReceiver = this.programCache
      ? new TSTypeCheckerUnionReceiverDispatchResolver(cfg, this.programCache)
      : null;
    this.strategies = [
      new TSSuperSymbolResolutionStrategy(cfg),
      new TSThisMemberSymbolResolutionStrategy(cfg),
      new TSFieldTypeSymbolResolutionStrategy(cfg),
      new TSLocalBindingSymbolResolutionStrategy(cfg),
      new TSNamedImportSymbolResolutionStrategy(cfg),
      new TSImportBasenameSymbolResolutionStrategy(cfg),
      new TSReceiverSymbolSymbolResolutionStrategy(cfg),
      new TSSameFileSymbolResolutionStrategy(cfg),
      new TSGlobalShortNameSymbolResolutionStrategy(cfg),
      new TSImportNarrowedFallbackSymbolResolutionStrategy(cfg),
    ];
    if (this.programCache) {
      this.strategies.push(
        new TSTypeCheckerJsxComponentSymbolResolutionStrategy(cfg, this.programCache),
        new TSTypeCheckerReturnTypeInferenceSymbolResolutionStrategy(cfg, this.programCache),
        new TSTypeCheckerFallbackSymbolResolutionStrategy(cfg, this.programCache),
        new TSStructuralTypingSymbolResolutionStrategy(cfg, this.programCache),
      );
    }
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return resolveViaChain(this.strategies, call, ctx);
  }

  /**
   * tea-rags-mcp-ykj7 — external-call classifier, used by the provider to move
   * an unresolved call out of the internal `resolveSuccessRate` denominator.
   *
   * The predicate itself lives in `./ts-external-call.ts` because it is no
   * longer only a post-hoc classifier: the same question guards the two
   * short-name passes BEFORE they match, which is what stops a bare `push` /
   * `error` from being matched to an unrelated project symbol of that name
   * (bd tea-rags-mcp-6b3gj). One definition, so the edge the chain declines to
   * emit and the call the metric excludes are always the same call.
   */
  targetsExternalImport(call: CallRef, ctx: CallContext): boolean {
    return targetsExternalImport(call, ctx, this.tsOptions);
  }

  /**
   * Fan-out resolution for lookup-table dispatch (bd tea-rags-mcp-n0zj).
   * Returns every edge a dispatching call implies:
   *
   *   - `call.dispatch` → fan out from the CALLER (sourceSymbolId null) to
   *     each candidate function the table selects. A dynamic key spans all
   *     entries; a static literal key picks the one matching entry.
   *   - `call.dispatchArgs` → bounded single-hop inter-procedural join:
   *     resolve the normal callee `F`, and for each dispatch candidate-set
   *     passed at one of `F`'s invoked param positions (`ctx.callbackParams`),
   *     fan out from `F` (sourceSymbolId = F) to each candidate.
   *
   * Unresolvable tables / candidate names are dropped (never fabricated).
   * The provider calls `resolve` separately for the normal callee edge.
   *
   * After the lookup-table fan-out, the CHA cone (bd tea-rags-mcp-k4wpn) runs:
   * an interface / class-typed receiver whose static type has subtypes
   * overriding the member fans out to N `cone` edges (or one `poly-base` edge
   * above the cone cap). The cone returns `[]` for every non-polymorphic call —
   * an `external` / unbound receiver carries no `localBinding`, so `T` is
   * undefined (external never cones). The lookup-table path takes precedence so
   * the existing dispatch-table behaviour is unchanged.
   */
  resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
    const edges: DispatchEdge[] = [];
    if (call.dispatch) {
      for (const target of this.expandCandidate(call.dispatch, ctx)) {
        edges.push({
          sourceSymbolId: null,
          targetRelPath: target.targetRelPath,
          targetSymbolId: target.targetSymbolId,
        });
      }
    }
    if (call.dispatchArgs && call.dispatchArgs.length > 0) {
      const callee = this.resolve(call, ctx);
      const calleeSymbolId = callee?.targetSymbolId ?? null;
      const invoked = calleeSymbolId ? ctx.callbackParams?.[calleeSymbolId] : undefined;
      if (calleeSymbolId && invoked && invoked.length > 0) {
        for (const arg of call.dispatchArgs) {
          if (!invoked.includes(arg.argIndex)) continue;
          for (const target of this.expandCandidate(arg.candidate, ctx)) {
            edges.push({
              sourceSymbolId: calleeSymbolId,
              targetRelPath: target.targetRelPath,
              targetSymbolId: target.targetSymbolId,
            });
          }
        }
      }
    }
    if (edges.length > 0) return { kind: "edges", edges };
    // Union receivers are decided before the CHA cone: the checker NAMES the
    // possible types, whereas CHA only knows a base type's descendants — and a
    // union annotation yields no `localBinding` at all, so the cone has no base
    // type to expand and would return `[]` here regardless (bd tea-rags-mcp-3yj7d).
    const union = this.unionReceiver?.resolveDispatch(call, ctx);
    if (union?.kind === "edges" && union.edges.length > 0) return union;
    // Neither table nor union matched — the cone outcome (bounded by design,
    // always kind "edges") is the answer either way.
    return this.cone.resolveDispatch(call, ctx);
  }

  /**
   * Expand a `DispatchRef` to the concrete call targets it can reach:
   * select the table (import-disambiguated), pull the candidate function
   * names for the field/key, resolve each name against the symbol table.
   * Deduped — a dynamic key over entries pointing at the same function
   * emits one edge, not N.
   */
  private expandCandidate(ref: DispatchRef, ctx: CallContext): SymbolResolutionTarget[] {
    const def = this.selectTableDef(ref.table, ctx);
    if (!def) return [];
    const targets: SymbolResolutionTarget[] = [];
    const seen = new Set<string>();
    for (const name of candidateNames(def.table, ref)) {
      const target = this.resolveCandidateName(name, ctx);
      if (!target) continue;
      const key = `${target.targetRelPath}::${target.targetSymbolId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(target);
    }
    return targets;
  }

  /**
   * Pick the `DispatchTableDef` for a table name. A name declared in a
   * single file resolves directly. When the same name is declared in
   * several files, the caller's import map disambiguates (prefer the
   * imported file, else the caller's own in-file table); if still
   * ambiguous, drop rather than guess (m46z safety).
   */
  private selectTableDef(name: string, ctx: CallContext): DispatchTableDef | null {
    const defs = ctx.dispatchTables?.[name];
    if (!defs || defs.length === 0) return null;
    if (defs.length === 1) return defs[0];
    const importedFiles = collectImportedFiles(ctx, this.tsOptions);
    const imported = defs.filter((d) => importedFiles.has(d.relPath));
    if (imported.length === 1) return imported[0];
    const inFile = defs.filter((d) => d.relPath === ctx.callerFile);
    if (inFile.length === 1) return inFile[0];
    return null;
  }

  /**
   * Resolve a bare candidate function name (a top-level function the
   * dispatch table points at) to its symbol. Single top-level definition
   * wins; on ambiguity the caller's import map narrows; otherwise drop.
   */
  private resolveCandidateName(name: string, ctx: CallContext): SymbolResolutionTarget | null {
    const candidates = ctx.symbolTable.lookupByShortName(name).filter((def) => def.scope.length === 0);
    const sole = pickSingleCandidate(candidates, this.mode);
    if (sole) return { targetRelPath: sole.relPath, targetSymbolId: sole.symbolId };
    if (candidates.length > 1) {
      const importedFiles = collectImportedFiles(ctx, this.tsOptions);
      const narrowed = candidates.filter((def) => importedFiles.has(def.relPath));
      const narrowedHit = pickSingleCandidate(narrowed, this.mode);
      if (narrowedHit) return { targetRelPath: narrowedHit.relPath, targetSymbolId: narrowedHit.symbolId };
    }
    return null;
  }
}

/**
 * Candidate function names a `DispatchRef` selects from a table.
 * Dynamic key → every entry; static key → the one matching entry.
 * S2 (`field === null`) reads the entry directly (must be a string fn name);
 * S1 reads `entry[field]`. Missing keys / wrong-shape entries contribute
 * nothing — the resolver then drops or fans out the rest.
 */
function candidateNames(table: DispatchTable, ref: DispatchRef): string[] {
  const keys = ref.key !== null ? [ref.key] : Object.keys(table.entries);
  const names: string[] = [];
  for (const key of keys) {
    const entry = table.entries[key];
    if (entry === undefined) continue;
    if (ref.field === null) {
      if (typeof entry === "string") names.push(entry);
    } else if (typeof entry === "object") {
      const fn = entry[ref.field];
      if (typeof fn === "string") names.push(fn);
    }
  }
  return names;
}
