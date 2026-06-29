import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef, SymbolResolutionTarget } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { SUPER_RECEIVER_SENTINEL } from "../../walker/walker.js";
import { firstDefinerAfter, resolveInstanceMethodInClassChain, type ResolverConfig } from "./shared.js";

/**
 * Ruby runtime hook methods whose `super` MUST NOT produce a file-only fallback
 * edge (bd tea-rags-mcp-08tss Part 2). These are methods whose super target is
 * ALWAYS BasicObject / Module in the Ruby runtime — emitting a file-only edge to
 * an in-project ancestor that doesn't define the hook would be a false edge.
 *
 * Only the file-only fallback is suppressed; a METHOD-LEVEL match in an ancestor
 * is still returned (a project that explicitly defines `method_missing` in a base
 * class IS a real edge).
 */
export const RUBY_RUNTIME_HOOKS = new Set([
  "method_missing",
  "respond_to_missing?",
  "method_added",
  "method_removed",
  "inherited",
  "included",
  "extended",
  "prepended",
  "const_missing",
  "singleton_method_added",
]);

/**
 * `super` / `zsuper` keyword (bd brp1). The walker emits a synthetic CallRef
 * whose receiver is `SUPER_RECEIVER_SENTINEL` and whose `member` is the
 * enclosing method's name — both decided at extraction time so the resolver
 * only needs to derive the parent class from `callerScope`. The enclosing class
 * is the full lexical scope chain joined with `::` (matching how
 * `collectRubyClassAncestors` keys its map); the walk looks for an INSTANCE
 * method with the same `member` on each ancestor in declaration order.
 *
 * This is the one **guard** strategy: when the receiver is the super sentinel it
 * is always terminal — it either resolves or **drops**, never continues. A bare
 * `super` with no resolvable ancestor MUST drop rather than fall through to the
 * later bare-call / receiver-set passes, which would fabricate a wrong edge
 * (bd tea-rags-mcp-jsa0 / lttd; same family as the TS bug 4rgg).
 */
export class RubySuperSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "super";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== SUPER_RECEIVER_SENTINEL) return CONTINUE;
    const target = this.resolveSuper(call.member, ctx);
    // `super` is terminal: a miss is a DROP, not a fall-through (bd jsa0/lttd).
    return target ? resolved(target) : DROP;
  }

  /**
   * Resolve a synthetic super-keyword CallRef (`receiver = "<super>"`).
   * The enclosing class is reconstructed from `callerScope` joined by
   * `::` (matching how `collectRubyClassAncestors` keys its map for
   * nested namespaces). The walk looks for an INSTANCE method with the
   * same `member` name on each ancestor in declaration order; the first
   * match wins. Class-form (`.`) candidates are accepted as a fallback
   * for singleton-method super calls (`def self.foo; super; end`).
   *
   * Returns null when:
   *   - `callerScope` is empty (super outside a class — shouldn't reach
   *     the resolver but defensively dropped),
   *   - the enclosing class has no `classAncestors` entry (no declared
   *     parent / mixins),
   *   - no ancestor resolves to a known file AND none defines `member`.
   *
   * A file-level edge with `targetSymbolId: null` is preferred over
   * `null` when an ancestor's file is known but the method isn't —
   * mirrors `resolveByLocalTypeInternal`'s behaviour so file-level
   * fan-in / fan-out stay accurate for out-of-project parents like
   * `ApplicationRecord` (whose `save` actually lives on
   * `ActiveRecord::Base` outside the index).
   */
  private resolveSuper(member: string, ctx: CallContext): SymbolResolutionTarget | null {
    if (ctx.callerScope.length === 0) return null;
    // FQ key matches `collectRubyClassAncestors` output: nested classes
    // become `Outer::Inner` via scope-stack join with `::`.
    const enclosingClass = ctx.callerScope.join("::");
    const ancestors = ctx.classAncestors?.[enclosingClass];
    if (!ancestors) {
      // Module with no own ancestors (e.g. `module Tracer` with no `include`):
      // the class-keyed walk has nothing to iterate, but the reverse-include
      // consensus path can still resolve if every including class agrees on the
      // same definer after the module in their MRO (bd cai0/2oky5).
      if (!RUBY_RUNTIME_HOOKS.has(member)) {
        const consensus = this.resolveViaIncludingClasses(enclosingClass, member, ctx);
        if (consensus) return consensus;
      }
      return null;
    }
    // `super` dispatches to the PARENT, never the enclosing class itself, so
    // start the MRO walk AT the ancestors with the enclosing class pre-seeded
    // into `visited`. Each ancestor reuses the shared class-chain walk (the same
    // traversal the `self.<member>` pass uses) — instance-method (`#`) and
    // class-form (`.`) candidates both bind by short name, covering
    // `def self.foo; super; end`. A file-only edge is preferred over `null` when
    // an ancestor's file is known but the method lives outside the project
    // (`ApplicationRecord#save` actually on `ActiveRecord::Base`).
    const visited = new Set<string>([enclosingClass]);
    let fileOnlyFallback: SymbolResolutionTarget | null = null;
    for (const ancestor of ancestors) {
      const resolvedTarget = resolveInstanceMethodInClassChain(ancestor, member, ctx, this.cfg.mode, visited);
      if (resolvedTarget === null) continue;
      if (resolvedTarget.targetSymbolId !== null) return resolvedTarget;
      if (fileOnlyFallback === null) fileOnlyFallback = resolvedTarget;
    }
    // Class-keyed walk fully missed — the module-method case: `super` lives in a
    // module M whose own ancestors don't define `member`. Resolve via the classes
    // that include/prepend M (ctx.includedBy), taking the target that is INVARIANT
    // across all of them (consensus → precision 1.0; disagreement → drop).
    // bd cai0/2oky5.
    if (fileOnlyFallback === null && !RUBY_RUNTIME_HOOKS.has(member)) {
      const consensus = this.resolveViaIncludingClasses(enclosingClass, member, ctx);
      if (consensus) return consensus;
    }
    if (fileOnlyFallback !== null && RUBY_RUNTIME_HOOKS.has(member)) return null;
    return fileOnlyFallback;
  }

  /**
   * Reverse-consensus resolution for `super` inside a MODULE method (bd cai0/2oky5).
   * For each class C that includes/prepends `moduleName`, find the first definer
   * of `member` AFTER `moduleName` in C's MRO. Emit an edge ONLY when every
   * including class agrees on the same target (precision 1.0); disagreement or an
   * empty set DROPs (returns null). Targets agree iff their `targetSymbolId` is
   * equal, or both are file-only with the same `targetRelPath`.
   */
  private resolveViaIncludingClasses(
    moduleName: string,
    member: string,
    ctx: CallContext,
  ): SymbolResolutionTarget | null {
    const including = ctx.includedBy?.[moduleName];
    if (!including || including.length === 0) return null;
    let agreed: SymbolResolutionTarget | null = null;
    for (const klass of including) {
      const t = firstDefinerAfter(moduleName, member, klass, ctx, this.cfg.mode);
      if (t === null) continue;
      if (agreed === null) {
        agreed = t;
        continue;
      }
      const same =
        agreed.targetSymbolId !== null || t.targetSymbolId !== null
          ? agreed.targetSymbolId === t.targetSymbolId
          : agreed.targetRelPath === t.targetRelPath;
      if (!same) return null; // including classes disagree → DROP (GUARD)
    }
    return agreed;
  }
}
