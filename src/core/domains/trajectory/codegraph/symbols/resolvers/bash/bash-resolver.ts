/**
 * Bash implementation of the `CallResolver` contract.
 *
 * Bash `source ./other.sh` and `. ./other.sh` produce ImportRefs with
 * the literal path. Internal function calls (no receiver) resolve via
 * global short-name lookup over the symbol table.
 */

import { posix } from "node:path";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type ResolvedTarget,
} from "../../../../../../contracts/types/codegraph.js";

export class BashCallResolver implements CallResolver {
  readonly language = "bash";

  constructor(private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {}

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    // Bash functions are global within the sourced file set, so a
    // bare call resolves via short-name lookup across all known
    // files. Strict mode keeps the existing N=1 guarantee; legacy
    // `first` mode takes any candidate.
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    const unique = pickSingleCandidate(fallback, this.mode);
    if (unique) {
      return { targetRelPath: unique.relPath, targetSymbolId: unique.symbolId };
    }
    // Multi-source case (only reachable in strict mode): filter to
    // files that are sourced by this caller (via the imports list).
    // After the filter we still demand a unique pick — sourcing two
    // files that both declare `cleanup()` is still ambiguous.
    if (fallback.length > 1) {
      const sourcedFiles = ctx.imports.map((imp) => mapBashSourceToFile(imp.importText, ctx.callerFile));
      const candidates = fallback.filter((def) => sourcedFiles.includes(def.relPath));
      const sourced = pickSingleCandidate(candidates, this.mode);
      if (sourced) {
        return { targetRelPath: sourced.relPath, targetSymbolId: sourced.symbolId };
      }
    }
    return null;
  }
}

export function mapBashSourceToFile(importText: string, callerFile: string): string {
  // Bash source paths are either absolute or relative to the caller.
  // Codegraph treats absolute paths as project-relative (caller never
  // passes shell-evaluated absolute paths like $HOME/.bashrc).
  const callerDir = posix.dirname(callerFile);
  return posix.normalize(posix.join(callerDir, importText));
}
