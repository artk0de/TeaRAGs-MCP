import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Bare-call fallback: receiver is null, so global short-name lookup is the only
 * signal we have. Useful for top-level helpers and Ruby's open-class additions
 * to existing constants. Filters the candidate list to ruby-language file paths
 * so cross-language index pollution (e.g. vendored JS / Java files under
 * `vendor/assets/javascripts/`) cannot surface as a Ruby edge — the symbol table
 * is language-agnostic (no `language` field on SymbolDefinition), so we gate on
 * the file extension (bug pl7k).
 *
 * This is the LAST pass: a miss continues (the chain then returns null
 * naturally), mirroring the original orchestrator's terminal `return null`.
 */
export class RubyBareCallSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "bareCall";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const fallback = ctx.symbolTable.lookupByShortName(call.member).filter((def) => isRubyPath(def.relPath));
    // Same-class scope preference (bug t5iw). When multiple short-name
    // candidates exist (e.g. `WebRequestConcern#user_agent` AND
    // `Agents::PhantomJsCloudAgent#user_agent`), strict-mode
    // pickSingleCandidate returns null and the edge drops silently.
    // Prefer candidates whose `scope[last]` matches the caller's
    // enclosing class — bare calls inside `Agents::PhantomJsCloudAgent`
    // should bind to that class's `user_agent` override, not be lost.
    // Mirrors the Java scope-filtered fallback (java-resolver.ts:50-54).
    // Ancestor-class preference is intentionally NOT applied here
    // (out-of-scope follow-up brp1) — only the direct enclosing class.
    if (fallback.length > 1 && ctx.callerScope.length > 0) {
      const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
      const sameClass = fallback.filter((def) => def.scope[def.scope.length - 1] === enclosing);
      if (sameClass.length === 1) {
        return resolved({ targetRelPath: sameClass[0].relPath, targetSymbolId: sameClass[0].symbolId });
      }
    }
    const target = pickSingleCandidate(fallback, this.cfg.mode);
    if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    return CONTINUE;
  }
}

/**
 * Defense-in-depth filter for the bare-call global short-name fallback.
 * The symbol table is shared across languages — a Ruby resolver MUST
 * NOT attribute a call edge to a JavaScript / Java / etc. definition,
 * because the file extensions and call semantics don't match.
 *
 * `SymbolDefinition` has no `language` field today, so we gate on the
 * file extension (`.rb`, `.rake`, `.gemspec` — every file that the
 * tea-rags Ruby walker would have parsed). Vendored JS in
 * `vendor/assets/javascripts/*.js` is the canonical false-positive
 * source (huginn `agents.map(&:id)` → `d3.js#map`).
 */
function isRubyPath(relPath: string): boolean {
  return relPath.endsWith(".rb") || relPath.endsWith(".rake") || relPath.endsWith(".gemspec");
}
