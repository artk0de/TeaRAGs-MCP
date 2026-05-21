/**
 * Bash implementation of the `CallResolver` contract.
 *
 * Bash `source ./other.sh` and `. ./other.sh` produce ImportRefs with
 * the literal path. Internal function calls (no receiver) resolve via
 * global short-name lookup over the symbol table.
 */

import { posix } from "node:path";

import type {
  CallContext,
  CallRef,
  CallResolver,
  ResolvedTarget,
} from "../../../../../../contracts/types/codegraph.js";

export class BashCallResolver implements CallResolver {
  readonly language = "bash";

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    // Bash functions are global within the sourced file set, so a
    // bare call resolves via short-name lookup across all known
    // files. If the symbol is unique, return it.
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    if (fallback.length === 1) {
      return { targetRelPath: fallback[0].relPath, targetSymbolId: fallback[0].symbolId };
    }
    // Multi-source case: filter to files that are sourced by this
    // caller (via the imports list).
    if (fallback.length > 1) {
      const sourcedFiles = ctx.imports.map((imp) => mapBashSourceToFile(imp.importText, ctx.callerFile));
      const candidates = fallback.filter((def) => sourcedFiles.includes(def.relPath));
      if (candidates.length === 1) {
        return { targetRelPath: candidates[0].relPath, targetSymbolId: candidates[0].symbolId };
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
