/**
 * Go implementation of the `CallResolver` contract.
 *
 * Go imports are package paths ("foo/bar"). Without GOPATH / module
 * config we can only resolve project-local packages via basename
 * heuristic: an import "foo/bar" hints that calls of `bar.Func` should
 * resolve to any file whose directory ends in `foo/bar`. Cross-module
 * imports (third-party) are out of scope — codegraph excludes
 * `vendor/` and the dependency directories the walker doesn't see.
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type ResolvedTarget,
} from "../../../../../../contracts/types/codegraph.js";

export class GoCallResolver implements CallResolver {
  readonly language = "go";

  constructor(private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {}

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    if (call.receiver) {
      const match = ctx.imports.find((imp) => importMatchesReceiver(imp.importText, call.receiver as string));
      if (match) {
        // Look up by short name globally first; restrict to a
        // candidate file whose path contains the import suffix.
        const suffix = match.importText.replace(/^\.\//, "");
        const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath.includes(suffix));
        const target = pickSingleCandidate(candidates, this.mode);
        if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
      }
    }
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    const target = pickSingleCandidate(fallback, this.mode);
    if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
    return null;
  }
}

function importMatchesReceiver(importText: string, receiver: string): boolean {
  const segments = importText.split("/");
  const last = segments[segments.length - 1] ?? "";
  return last === receiver;
}
