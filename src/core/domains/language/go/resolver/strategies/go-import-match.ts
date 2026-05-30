import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { importMatchesReceiver, type ResolverConfig } from "./shared.js";

/**
 * Step 1 — the receiver matches an import path's last segment. Go imports are
 * package paths (`foo/bar`); without GOPATH / module config we can only resolve
 * project-local packages via basename heuristic — an import `foo/bar` hints that
 * calls of `bar.Func` should resolve to any file whose directory ends in
 * `foo/bar`. Look up the member by short name globally, then restrict to a
 * candidate file whose path contains the import suffix.
 *
 * Non-guard: a miss (no matching import, or no single candidate in the matched
 * package) CONTINUEs to the receiver-present drop. Cross-module imports
 * (third-party) are out of scope; codegraph excludes `vendor/` and dependency
 * directories the walker doesn't see.
 */
export class GoImportMatchSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "importMatch";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const { receiver } = call;
    if (!receiver) return CONTINUE;
    const match = ctx.imports.find((imp) => importMatchesReceiver(imp.importText, receiver));
    if (!match) return CONTINUE;
    const suffix = match.importText.replace(/^\.\//, "");
    const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath.includes(suffix));
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    return CONTINUE;
  }
}
