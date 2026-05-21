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

import type {
  CallContext,
  CallRef,
  CallResolver,
  ResolvedTarget,
} from "../../../../../../contracts/types/codegraph.js";

export class GoCallResolver implements CallResolver {
  readonly language = "go";

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    if (call.receiver) {
      const match = ctx.imports.find((imp) => importMatchesReceiver(imp.importText, call.receiver as string));
      if (match) {
        // Look up by short name globally first; restrict to a
        // candidate file whose path contains the import suffix.
        const suffix = match.importText.replace(/^\.\//, "");
        const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath.includes(suffix));
        const target = candidates[0];
        if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
      }
    }
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    if (fallback.length === 1) {
      return { targetRelPath: fallback[0].relPath, targetSymbolId: fallback[0].symbolId };
    }
    return null;
  }
}

function importMatchesReceiver(importText: string, receiver: string): boolean {
  const segments = importText.split("/");
  const last = segments[segments.length - 1] ?? "";
  return last === receiver;
}
