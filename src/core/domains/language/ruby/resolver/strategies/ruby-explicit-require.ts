import { posix } from "node:path";

import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { ZEITWERK_PREFIX } from "../../walker/walker.js";
import { collectKnownPaths, type ResolverConfig } from "./shared.js";

/**
 * Explicit `require` / `require_relative`. Fires ONLY when the receiver names
 * the import (i.e. `foo.bar` after `require 'foo'`, or `foo.bar` after
 * `require_relative './foo'`). Bare calls (`call.receiver === null`) MUST NOT
 * enter this branch — the bug jsa0 was a pair of always-true predicates that
 * absorbed every bare call into an arbitrary file edge, blocking the t5iw
 * same-class fallback in the bare-call pass. Bare-call resolution belongs in the
 * global short-name fallback path which already gates on language + scope.
 *
 * Continues (NOT drops) when no import matches the receiver or the matched
 * require can't be resolved to a file — later passes still apply. Once the
 * require resolves to a file this pass always resolves (a file-only edge counts).
 */
export class RubyExplicitRequireSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "explicitRequire";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const requireMatch =
      call.receiver === null
        ? undefined
        : ctx.imports.find((imp) => {
            if (imp.importText.startsWith(ZEITWERK_PREFIX)) return false;
            if (imp.importText.startsWith("./")) {
              // require_relative — match when receiver text equals the
              // imported basename. Accept both the bare basename
              // (`foo.bar` after `require_relative './foo'` — the
              // typical case) and the literal importText (`./foo`) for
              // synthetic call sites.
              return call.receiver === imp.importText.slice(2) || call.receiver === imp.importText;
            }
            // bare `require 'foo'` — match when receiver text equals importText.
            return call.receiver === imp.importText;
          });

    if (!requireMatch) return CONTINUE;
    const targetFile = this.resolveExplicitRequire(requireMatch.importText, ctx.callerFile, collectKnownPaths(ctx));
    if (!targetFile) return CONTINUE;
    const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath === targetFile);
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    return resolved({ targetRelPath: targetFile, targetSymbolId: null });
  }

  private resolveExplicitRequire(importText: string, callerFile: string, knownPaths: Iterable<string>): string | null {
    if (importText.startsWith("./")) {
      // require_relative — resolve against caller's directory.
      const stripped = importText.slice(2);
      const withExt = stripped.endsWith(".rb") ? stripped : `${stripped}.rb`;
      const target = posix.normalize(posix.join(posix.dirname(callerFile), withExt));
      return target;
    }
    // Bare require — basename match across known paths.
    const wanted = importText.endsWith(".rb") ? importText : `${importText}.rb`;
    for (const p of knownPaths) {
      if (p === wanted) return p;
      if (p.endsWith(`/${wanted}`)) return p;
    }
    return null;
  }
}
