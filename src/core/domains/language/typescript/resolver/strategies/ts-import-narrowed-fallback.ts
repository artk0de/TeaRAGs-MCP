import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
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
 */
export class TSImportNarrowedFallbackSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "importNarrowedFallback";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    if (fallback.length <= 1 || ctx.imports.length === 0) return CONTINUE;

    const importedFiles = collectImportedFiles(ctx, this.cfg.tsOptions);
    if (importedFiles.size === 0) return CONTINUE;

    const narrowed = fallback.filter((def) => importedFiles.has(def.relPath));
    const narrowedHit = pickSingleCandidate(narrowed, this.cfg.mode);
    if (narrowedHit) return resolved({ targetRelPath: narrowedHit.relPath, targetSymbolId: narrowedHit.symbolId });
    return CONTINUE;
  }
}
