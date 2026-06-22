import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef, SymbolResolutionTarget } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { SUPER_RECEIVER_SENTINEL } from "../../walker/walker.js";
import { resolveInstanceMethodInClassChain, type ResolverConfig } from "./shared.js";

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
    if (!ancestors) return null;
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
    return fileOnlyFallback;
  }
}
