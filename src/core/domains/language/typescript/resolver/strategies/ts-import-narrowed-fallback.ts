import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { targetsExternalImport } from "../ts-external-call.js";
import { calleeIsLocalValueBinding } from "../ts-local-callee.js";
import { receiverIsUnpinnableLocalValueBinding } from "../ts-local-receiver.js";
import type { TSProgramCache } from "../ts-program-cache.js";
import { collectImportedFiles, type ResolverConfig } from "./shared.js";

/**
 * Imports-narrowed fallback (bd tea-rags-mcp-2qp6). Recovery for the
 * interface-dispatch shape `param.method()` where `param: SomeInterface` — the
 * walker has no parameter-type info, so global short-name lookup sees every
 * implementer and strict mode drops them all. The caller's import list is the
 * only signal available to bias toward the concrete implementer this caller can
 * reach. If exactly one ambiguous candidate's file is in `ctx.imports`, resolve
 * to it; otherwise ambiguity is real and we continue (→ chain returns null).
 * Only engages when N>1 (so the N=1 fast path in `globalShortName` keeps current
 * semantics) and only when imports could resolve.
 *
 * Shares `globalShortName`'s external guard, and needs it more (bd
 * tea-rags-mcp-6b3gj): narrowing by imports turns an ambiguous bare member name
 * into a CONFIDENT answer, so an unguarded `out.push()` here does not merely
 * guess — it picks one implementer and commits to it.
 *
 * Including the checker-backed arm the guard gained in bd tea-rags-mcp-335eu:
 * `cache.set(k, v)` on a Map the walker could not type is narrowed to whichever
 * imported file happens to declare a `set`, which is the confident version of
 * the same mistake.
 *
 * Shares {@link calleeIsLocalValueBinding} for the same reason (bd
 * tea-rags-mcp-5tatv): a bare `onRemove(attachment)` whose callee is a
 * destructured prop is ambiguous by short name across N implementers, and
 * narrowing by the caller's imports would pick one and commit to it.
 *
 * And {@link receiverIsUnpinnableLocalValueBinding} for the dispatching twin of
 * that shape (bd tea-rags-mcp-z0zqd): `handlers.remove(index)` on a receiver the
 * checker can name no in-project type for is ambiguous across every project
 * `remove`, and narrowing by imports is again the confident version of the same
 * mistake.
 */
export class TSImportNarrowedFallbackSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "importNarrowedFallback";
  constructor(
    private readonly cfg: ResolverConfig,
    private readonly programCache: TSProgramCache | null = null,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (targetsExternalImport(call, ctx, this.cfg.tsOptions, this.programCache)) return CONTINUE;
    if (calleeIsLocalValueBinding(call, ctx, this.programCache)) return CONTINUE;
    if (receiverIsUnpinnableLocalValueBinding(call, ctx, this.programCache)) return CONTINUE;
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    if (fallback.length <= 1 || ctx.imports.length === 0) return CONTINUE;

    const importedFiles = collectImportedFiles(ctx, this.cfg.tsOptions, this.cfg.fileExists);
    if (importedFiles.size === 0) return CONTINUE;

    const narrowed = fallback.filter((def) => importedFiles.has(def.relPath));
    const narrowedHit = pickSingleCandidate(narrowed, this.cfg.mode);
    if (narrowedHit) return resolved({ targetRelPath: narrowedHit.relPath, targetSymbolId: narrowedHit.symbolId });
    return CONTINUE;
  }
}
