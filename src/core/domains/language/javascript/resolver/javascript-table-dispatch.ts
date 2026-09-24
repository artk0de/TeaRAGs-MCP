import { identifierEntry } from "../../../../contracts/identifier-record.js";
import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type DispatchEdge,
  type DispatchFanoutOutcome,
  type DispatchRef,
  type DispatchTable,
  type DispatchTableDef,
  type SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type { DispatchResolverComponent, ImportFileMapper } from "../../../../contracts/types/language.js";
import { lookupEcmascriptSymbolsByShortName } from "../../shared/ecmascript-symbol-lookup.js";

/** The normal single-target resolution of a call — the callee side of the join. */
export type JavascriptCalleeResolver = (call: CallRef, ctx: CallContext) => SymbolResolutionTarget | null;

/**
 * Lookup-table dispatch fan-out for JavaScript (bd tea-rags-mcp-hkj8) — the
 * port of `TSCallResolver#resolveDispatch`'s table half (bd tea-rags-mcp-n0zj).
 * Returns every edge a dispatching call implies:
 *
 *   - `call.dispatch` → fan out from the CALLER (sourceSymbolId null) to each
 *     candidate function the table selects. A dynamic key spans all entries; a
 *     static literal key picks the one matching entry.
 *   - `call.dispatchArgs` → bounded single-hop inter-procedural join: resolve
 *     the normal callee `F`, and for each candidate-set passed at one of `F`'s
 *     invoked parameter positions (`ctx.callbackParams`), fan out from `F`
 *     (sourceSymbolId = F) to each candidate.
 *
 * Unresolvable tables and candidate names are dropped, never fabricated; a
 * table name or candidate name declared in more than one file is narrowed by
 * the caller's imports and otherwise dropped (m46z). Returns no edges for every
 * call that carries neither channel.
 */
export class JavascriptTableDispatchResolver implements DispatchResolverComponent {
  constructor(
    private readonly mode: AmbiguousResolveMode,
    private readonly importFileMapper: ImportFileMapper,
    private readonly resolveCallee: JavascriptCalleeResolver,
  ) {}

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
      const calleeSymbolId = this.resolveCallee(call, ctx)?.targetSymbolId ?? null;
      const invoked = calleeSymbolId ? identifierEntry(ctx.callbackParams, calleeSymbolId) : undefined;
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
    return { kind: "edges", edges };
  }

  /**
   * Expand a `DispatchRef` to the concrete call targets it can reach: select
   * the table (import-disambiguated), pull the candidate function names for the
   * field/key, resolve each name. Deduped — a dynamic key over entries pointing
   * at the same function emits one edge, not N.
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
   * A name declared in one file resolves directly. Declared in several, the
   * caller's imports decide (prefer the imported file, else the caller's own
   * in-file table); still ambiguous → drop rather than guess.
   */
  private selectTableDef(name: string, ctx: CallContext): DispatchTableDef | null {
    const defs = identifierEntry(ctx.dispatchTables, name);
    if (!defs || defs.length === 0) return null;
    if (defs.length === 1) return defs[0];
    const importedFiles = this.importedProjectFiles(ctx);
    const imported = defs.filter((d) => importedFiles.has(d.relPath));
    if (imported.length === 1) return imported[0];
    const inFile = defs.filter((d) => d.relPath === ctx.callerFile);
    return inFile.length === 1 ? inFile[0] : null;
  }

  /**
   * A bare candidate function name — a top-level ECMAScript function the table
   * points at. A single definition wins; on ambiguity the caller's imports
   * narrow; otherwise drop.
   */
  private resolveCandidateName(name: string, ctx: CallContext): SymbolResolutionTarget | null {
    const candidates = lookupEcmascriptSymbolsByShortName(ctx, name).filter((def) => def.scope.length === 0);
    const sole = pickSingleCandidate(candidates, this.mode);
    if (sole) return { targetRelPath: sole.relPath, targetSymbolId: sole.symbolId };
    if (candidates.length > 1) {
      const importedFiles = this.importedProjectFiles(ctx);
      const narrowed = pickSingleCandidate(
        candidates.filter((def) => importedFiles.has(def.relPath)),
        this.mode,
      );
      if (narrowed) return { targetRelPath: narrowed.relPath, targetSymbolId: narrowed.symbolId };
    }
    return null;
  }

  /** Project files the caller's imports name — only files the index holds. */
  private importedProjectFiles(ctx: CallContext): Set<string> {
    const files = new Set<string>();
    for (const imp of ctx.imports) {
      const target = this.importFileMapper.mapImportToFile(imp.importText, ctx.callerFile, ctx);
      if (target.kind === "project") files.add(target.relPath);
    }
    return files;
  }
}

/**
 * Candidate function names a `DispatchRef` selects from a table. Dynamic key →
 * every entry; static key → the one matching entry. S2 (`field === null`) reads
 * the entry directly (must be a fn name); S1 reads `entry[field]`. Missing keys
 * and wrong-shape entries contribute nothing.
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
