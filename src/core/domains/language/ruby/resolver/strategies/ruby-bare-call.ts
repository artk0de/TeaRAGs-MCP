import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import {
  collectResolvedAncestorChain,
  isRubyPath,
  lastConstantSegment,
  resolveViaIncludingClasses,
  symbolIdIsInstanceMethod,
  type ResolverConfig,
} from "./shared.js";

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
    // Anchor the MRO walk on the enclosing class. For a CLASS/MODULE-body chunk
    // (a callback / association edge assigned to the class chunk), `callerScope`
    // OMITS the class's own name by convention — and is EMPTY for a top-level
    // class — so it cannot pin the enclosing class, and every ambiguous class-body
    // self-send silently strict-continues (bd lawlq.3.2, the dominant bareCall
    // miss bucket). `callerSymbolId` carries the full FQ; a class/module chunk's
    // id has no `#`/`.` (only `::` namespace), a method chunk's does — so a method
    // body keeps `callerScope` (already the full class path, correct today).
    const classBodyEnclosing =
      ctx.callerSymbolId !== undefined && !ctx.callerSymbolId.includes("#") && !ctx.callerSymbolId.includes(".")
        ? ctx.callerSymbolId
        : null;
    const enclosing = classBodyEnclosing ?? (ctx.callerScope.length > 0 ? ctx.callerScope.join("::") : null);
    if (fallback.length > 1 && enclosing !== null) {
      // Per-hop FQ canonicalization (bd lawlq.3.4): `classAncestors` VALUES are
      // raw source text, so a mixin chain whose hops are namespaced would
      // dead-end under a raw-string walk before reaching the DSL-method owner.
      const mro = [enclosing, ...collectResolvedAncestorChain(enclosing, ctx)];
      let brokeAmbiguous = false;
      for (const klass of mro) {
        // Match a candidate's enclosing-scope tail against the MRO class in
        // EITHER stored form: the compact FQ (`["Api::BaseController"]`) or the
        // bare last segment (`["Admin","BaseController"]` → "BaseController").
        // The walker emits both depending on how the class header was declared
        // (`class Api::BaseController` vs nested `module Admin; class …`), so
        // comparing only the last segment silently missed every namespaced base
        // class / concern (cai0/n2kpz). Mirrors the scope-tail check in
        // shared.ts `resolveTypeMethodInternal`.
        const short = lastConstantSegment(klass);
        // Exact-FQ tier first (bd tea-rags-mcp-lawlq.3.5): a candidate whose FULL
        // scope joins to `klass` is the literal same-class def. `scope.join("::")`
        // normalizes both stored forms (compact-FQ `["Admin::InvitesController"]`
        // and nested `["Admin","InvitesController"]`), so a namespaced self-def is
        // no longer conflated with a same-last-segment top-level namesake
        // (`Admin::InvitesController#resource_params` vs `InvitesController#…`),
        // which the tail-only compare matched together → strict-continue.
        // Exact-FQ tier: candidate's FULL scope equals klass. `join("::")`
        // normalizes compact (`["Admin::X"]`) and nested (`["Admin","X"]`) forms.
        // NO last-segment disjunct — a BARE klass "X" (which M1 now feeds for a
        // top-level class-body chunk) must NOT pull a namespaced namesake
        // `["Api","X"]` into the exact tier (bd lawlq.3.7 false-edge fix).
        const exactTier = fallback.filter((def) => def.scope.join("::") === klass);
        if (exactTier.length === 1) {
          return resolved({ targetRelPath: exactTier[0].relPath, targetSymbolId: exactTier[0].symbolId });
        }
        if (exactTier.length > 1) {
          brokeAmbiguous = true;
          break; // ambiguous inside the exact class — do NOT guess
        }
        // Loose tier — the walker stored the def's class WITHOUT its namespace
        // (`["X"]` for `Agents::X`): the candidate's ENTIRE scope equals klass's
        // last segment. `join("::") === short` (not `tail === short`) so a
        // namespaced namesake (`["Api","X"]`, join `"Api::X"`) is excluded.
        const looseTier = fallback.filter((def) => def.scope.join("::") === short);
        if (looseTier.length === 1) {
          return resolved({ targetRelPath: looseTier[0].relPath, targetSymbolId: looseTier[0].symbolId });
        }
        if (looseTier.length > 1) {
          brokeAmbiguous = true;
          break;
        }
      }
      // Concern-scope fallback (bd lawlq.3.2 facet-2): the class-MRO missed and the
      // enclosing is a MODULE (concern) whose own MRO does not define `member`.
      // Resolve via the classes that include the module, taking the target that is
      // invariant across all of them (consensus → precision 1.0). Skipped after an
      // ambiguous break — that is a genuine same-class collision, not a miss.
      if (!brokeAmbiguous && ctx.includedBy?.[enclosing]?.length) {
        const consensus = resolveViaIncludingClasses(enclosing, call.member, ctx, this.cfg.mode);
        if (consensus) return resolved(consensus);
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
