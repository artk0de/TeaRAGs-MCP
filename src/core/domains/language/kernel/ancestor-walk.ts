/**
 * Ancestor walk — the language-NEUTRAL half of a method-resolution-order
 * linearization (E2 seam 4, relocated from `ruby/resolver/ancestor-linearization.ts`).
 *
 * What lives here is the DRIVER: the recursion, the per-path cycle guard, the
 * already-reachable dedupe filter, the per-run memo, and the first-definition-wins
 * member scan. All five are the same in every language that has inheritance, and
 * none of them can be written twice without the two copies drifting.
 *
 * ORDER is not neutral and never enters this file. Ruby's module-insertion rule
 * (prepends, then the class, then includes ranked last-declared-nearest, then the
 * superclass chain) and Python's C3 merge are two different answers to the same
 * question; each language supplies exactly one as an `AncestorLinearizationPolicy`
 * and the driver calls it. A separator, a builtin base name, a mixin keyword or a
 * merge rule appearing here is a defect, not an optimization.
 *
 * ZERO runtime imports, inherited from the Ruby module this came out of:
 * `type-propagation.ts` cannot reach `strategies/shared.ts` (that pulls
 * `walker.ts` → `type-sources/ast-inference` → back into `type-propagation`, a
 * cycle that breaks its top-level const init), so the substrate both sides share
 * has to be a leaf. Hierarchy shapes stay STRUCTURAL — the context is a type
 * parameter, so a `CallContext` satisfies it without being imported.
 */

/**
 * How completely a linearization could be read. `closed` — every branch ended on
 * a class the project owns, so an absent member really is absent. `external` — a
 * branch left the project, so a miss proves nothing and fabricating a target
 * there is a phantom. `unknown` — a branch could not be classified at all.
 */
export type AncestorClosure = "closed" | "external" | "unknown";

/** The ORDER half of an ancestor walk: everything the driver refuses to guess. */
export interface AncestorLinearizationPolicy<TCtx> {
  /**
   * `classKey`'s direct ancestors, expanded and ranked by the language's own
   * rule, with `classKey` itself at its true position. `recurse` linearizes one
   * ancestor under the driver's cycle guard; `insertable` does the same and then
   * drops whatever is already reachable through any of the `present` regions.
   */
  order: (
    classKey: string,
    ctx: TCtx,
    recurse: (ancestor: string) => string[],
    insertable: (ancestor: string, present: readonly (readonly string[])[]) => string[],
  ) => string[];
  /** Per-class boundary verdict; absent means the language never leaves the project. */
  boundaryOf?: (classKey: string, ctx: TCtx) => AncestorClosure;
}

/** One class's ancestors, nearest first, with how far the walk could actually see. */
export interface LinearizedAncestors {
  readonly order: readonly string[];
  readonly closure: AncestorClosure;
}

/** A linearizer bound to one context, memoizing per class key for the run. */
export interface AncestorLinearizer<TCtx> {
  /**
   * The context every linearization here is bound to. Exposed because the
   * binding is the point: a linearizer answers for ONE run's hierarchy, and a
   * consumer holding it needs no second reference to say which.
   */
  readonly ctx: TCtx;
  linearize: (classKey: string) => LinearizedAncestors;
}

/** What a member scan found, and how much of the hierarchy it got to look at. */
export interface AncestorMemberScan<TTarget> {
  readonly target: TTarget | null;
  readonly definingClassKey: string | null;
  readonly closure: AncestorClosure;
}

const CLOSURE_RANK: Record<AncestorClosure, number> = {
  closed: 0,
  unknown: 1,
  external: 2,
};

/** Precision-first join: an external boundary anywhere makes the whole answer external. */
function joinClosure(a: AncestorClosure, b: AncestorClosure): AncestorClosure {
  return CLOSURE_RANK[b] > CLOSURE_RANK[a] ? b : a;
}

export function createAncestorLinearizer<TCtx>(
  ctx: TCtx,
  policy: AncestorLinearizationPolicy<TCtx>,
): AncestorLinearizer<TCtx> {
  // Only the TOP-LEVEL entry memoizes. The inner recursion carries a per-PATH
  // guard, so its result is path-dependent in a cyclic hierarchy and caching it
  // would leak one branch's truncation into another.
  const memo = new Map<string, LinearizedAncestors>();

  const walk = (classKey: string, path: ReadonlySet<string>, seen: Set<string>): string[] => {
    if (path.has(classKey)) return [];
    const nextPath = new Set(path).add(classKey);
    seen.add(classKey);
    const recurse = (ancestor: string): string[] => walk(ancestor, nextPath, seen);
    const insertable = (ancestor: string, present: readonly (readonly string[])[]): string[] =>
      recurse(ancestor).filter((name) => !present.some((region) => region.includes(name)));
    return policy.order(classKey, ctx, recurse, insertable);
  };

  return {
    ctx,
    linearize(classKey: string): LinearizedAncestors {
      const hit = memo.get(classKey);
      if (hit !== undefined) return hit;
      const seen = new Set<string>();
      const order = walk(classKey, new Set(), seen);
      let closure: AncestorClosure = "closed";
      if (policy.boundaryOf !== undefined) {
        for (const visited of seen) closure = joinClosure(closure, policy.boundaryOf(visited, ctx));
      }
      const result: LinearizedAncestors = { order, closure };
      memo.set(classKey, result);
      return result;
    },
  };
}

/**
 * The FIRST class in `classKey`'s linearization that owns `member`, per
 * `lookup`. `startAfter` skips the linearization up to and INCLUDING
 * `classKey`'s own position — the `super` semantics, where dispatch begins at
 * the next entry, never the enclosing class itself.
 */
export function findMemberInAncestorChain<TCtx, TTarget>(
  classKey: string,
  linearizer: AncestorLinearizer<TCtx>,
  lookup: (candidateKey: string) => TTarget | null,
  options: { readonly startAfter?: boolean } = {},
): AncestorMemberScan<TTarget> {
  const { order, closure } = linearizer.linearize(classKey);
  const self = order.indexOf(classKey);
  const from = options.startAfter === true ? (self === -1 ? order.length : self + 1) : 0;
  for (let i = from; i < order.length; i++) {
    const target = lookup(order[i]);
    if (target !== null) return { target, definingClassKey: order[i], closure };
  }
  return { target: null, definingClassKey: null, closure };
}
