import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { collectAncestorChain, isRubyPath, symbolIdIsInstanceMethod, type ResolverConfig } from "./shared.js";

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
    // MRO-aware scope narrowing (bug t5iw + brp1). When multiple short-name
    // candidates exist (e.g. `WebRequestConcern#user_agent` AND
    // `Agents::PhantomJsCloudAgent#user_agent`), strict-mode
    // pickSingleCandidate returns null and the edge drops silently.
    // Walk the caller's MRO nearest-first — the enclosing class followed by
    // its `classAncestors` chain in declaration order — and prefer the unique
    // candidate at the closest level. The first iteration subsumes the old
    // direct-enclosing case (t5iw); subsequent iterations bind inherited
    // methods on a superclass / mixin (brp1: an ambiguous bare call whose true
    // target is an INHERITED method was previously dropped). Mirrors the Java
    // scope-filtered fallback (java-resolver.ts:50-54), generalized to the MRO.
    if (fallback.length > 1 && ctx.callerScope.length > 0) {
      const enclosing = ctx.callerScope.join("::");
      const mro = [enclosing, ...collectAncestorChain(enclosing, ctx)];
      for (const klass of mro) {
        const short = klass.split("::").pop();
        const atLevel = fallback.filter((def) => def.scope[def.scope.length - 1] === short);
        if (atLevel.length === 1) {
          return resolved({ targetRelPath: atLevel[0].relPath, targetSymbolId: atLevel[0].symbolId });
        }
        // Genuinely ambiguous within one class — do NOT guess; fall through to
        // pickSingleCandidate (which CONTINUEs in strict mode).
        if (atLevel.length > 1) break;
      }
    }
    // RC-1 (tea-rags-mcp-55xil): cross-FORM preference — before falling through
    // to pickSingleCandidate, try to break the ambiguity by dropping class-form
    // (`.method`) candidates when at least one instance-form (`#method`) or
    // top-level candidate exists. A mixin module's bare call almost always
    // targets an instance method; a same-named class-method (e.g.
    // `Octokit::Default.client_id` vs `Octokit::Configurable#client_id`) is a
    // different dispatch form and should not compete with it.
    //
    // Only applies when the filtered set is STRICTLY SMALLER than `fallback`
    // (i.e. at least one class-form candidate was dropped) AND non-empty.
    // Genuinely-ambiguous SAME-form candidates (two instance methods in unrelated
    // classes) are NOT affected — the filter leaves the set unchanged and
    // pickSingleCandidate still CONTINUEs in strict mode.
    let effective = fallback;
    if (fallback.length > 1) {
      const instanceOrTopLevel = fallback.filter(
        (def) => symbolIdIsInstanceMethod(def.symbolId, call.member) || def.symbolId === call.member,
      );
      if (instanceOrTopLevel.length > 0 && instanceOrTopLevel.length < fallback.length) {
        effective = instanceOrTopLevel;
      }
    }
    const target = pickSingleCandidate(effective, this.cfg.mode);
    if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    return CONTINUE;
  }
}
