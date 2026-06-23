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
 *
 * `resolveDispatch` is a separate fan-out contract (lookup-table dispatch, bd
 * tea-rags-mcp-n0zj) and stays in the orchestrator — it is not part of the
 * single-target resolution chain.
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  pickSingleCandidate,
  resolveLocalBindingType,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type DispatchEdge,
  type DispatchRef,
  type DispatchTable,
  type DispatchTableDef,
  type SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type { SymbolResolutionStrategy } from "../../../../contracts/types/language.js";
import { ConeDispatchResolver } from "../../cone-dispatch.js";
import { resolveViaChain } from "../../resolver-chain.js";
import { ECMASCRIPT_BUILTIN_TYPES, ECMASCRIPT_GLOBALS } from "../../shared/ecmascript-globals.js";
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
  TSSuperSymbolResolutionStrategy,
  TSThisMemberSymbolResolutionStrategy,
  type ResolverConfig,
} from "./strategies/index.js";
import { mapImportToFile, type TsCompilerOptions } from "./ts-path-mapper.js";

/** Parse `CODEGRAPH_TS_CONE_MAX`; fall back to the TS default on absent/invalid. */
function resolveConeMax(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : CONE_MAX_DEFAULT;
}

export class TSCallResolver implements CallResolver {
  readonly language = "typescript";
  private readonly strategies: SymbolResolutionStrategy[];
  private readonly cone: ConeDispatchResolver;

  constructor(
    private readonly tsOptions: TsCompilerOptions,
    private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  ) {
    const cfg: ResolverConfig = { tsOptions, mode, coneMax: resolveConeMax(process.env.CODEGRAPH_TS_CONE_MAX) };
    this.cone = new ConeDispatchResolver(new TSConeTypeLocator(cfg), cfg.coneMax ?? CONE_MAX_DEFAULT);
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
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return resolveViaChain(this.strategies, call, ctx);
  }

  /**
   * tea-rags-mcp-ykj7 — external-import classifier for an UNRESOLVED call.
   * `true` when any of:
   *   1. the receiver is an ECMAScript ambient global (`Math.max`,
   *      `console.log` — no import to match);
   *   2. the receiver / member binds to an import whose specifier does NOT map
   *      to a project file (`node:fs`, bare npm packages) — `mapImportToFile`
   *      returns `null` for exactly those (relative + tsconfig-`paths` resolve);
   *   3. the receiver's declared TYPE is an ECMAScript runtime builtin (`Map`,
   *      `Set`, `Promise`, typed arrays, …): `m.get()`, `this.pending.set()`,
   *      `arr.map()`, `p.then()` target the JS runtime instance method, not an
   *      in-repo symbol — same class of miss as a `node:fs` import.
   *
   * PRECISION: case 3 only fires on a CONFIDENTLY-bound builtin type (an actual
   * local-binding / class-field type that is a builtin name). An unknown /
   * unbound receiver stays an internal miss — we never hide a real in-repo gap.
   * Because the provider only calls this on unresolved calls, a path-aliased
   * internal import (or an in-repo-typed receiver) that resolved never reaches
   * here.
   */
  targetsExternalImport(call: CallRef, ctx: CallContext): boolean {
    const { receiver } = call;
    if (receiver !== null && ECMASCRIPT_GLOBALS.has(receiver)) return true;
    // Receiver-bound external, or a bare named import called directly
    // (`import { readFile } from "node:fs"` → `readFile()`).
    const boundName = receiver ?? call.member;
    if (boundName.length === 0) return false;
    for (const imp of ctx.imports) {
      if (
        imp.importedNames?.includes(boundName) &&
        mapImportToFile(imp.importText, ctx.callerFile, this.tsOptions) === null
      ) {
        return true;
      }
    }
    return this.receiverTypeIsBuiltin(call, ctx);
  }

  /**
   * Case 3 of {@link targetsExternalImport}: resolve the receiver's declared
   * type and report whether it is an ECMAScript runtime builtin.
   *
   *   - `this.<field>.x()` → field type from `ctx.classFieldTypes[scope][field]`
   *     (mirrors {@link TSFieldTypeSymbolResolutionStrategy}); chained
   *     `this.a.b.x()` is out of scope (one level only).
   *   - bare `<name>.x()` → walker-bound local type via
   *     {@link resolveLocalBindingType} (mirrors
   *     {@link TSLocalBindingSymbolResolutionStrategy}).
   *
   * Returns `false` when the receiver has no confidently-bound type — keeping
   * unknown receivers as internal misses (precision over recall).
   */
  private receiverTypeIsBuiltin(call: CallRef, ctx: CallContext): boolean {
    const { receiver } = call;
    if (receiver === null || receiver.length === 0) return false;
    let typeName: string | undefined;
    if (receiver.startsWith("this.")) {
      const fieldSegment = receiver.slice("this.".length);
      if (fieldSegment.includes(".") || ctx.callerScope.length === 0) return false;
      const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
      typeName = ctx.classFieldTypes?.[enclosing]?.[fieldSegment];
    } else {
      typeName = resolveLocalBindingType(ctx.localBindings, receiver, call.startLine) ?? undefined;
    }
    return typeName !== undefined && ECMASCRIPT_BUILTIN_TYPES.has(typeName);
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
  resolveDispatch(call: CallRef, ctx: CallContext): DispatchEdge[] {
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
    if (edges.length > 0) return edges;
    const cone = this.cone.resolveDispatch(call, ctx);
    if (cone.length > 0) return cone;
    return edges;
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
