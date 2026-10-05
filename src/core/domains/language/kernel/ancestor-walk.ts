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
 * A LEAF, inherited from the Ruby module this came out of: `type-propagation.ts`
 * cannot reach `strategies/shared.ts` (that pulls `walker.ts` →
 * `type-sources/ast-inference` → back into `type-propagation`, a cycle that
 * breaks its top-level const init), so the substrate both sides share has to be
 * a leaf. Its one runtime import is `./run-scoped-memo.ts`, itself a leaf with
 * type-only imports. Hierarchy shapes stay STRUCTURAL — the context is a type
 * parameter, so a `CallContext` satisfies it without being imported.
 */

import type { ResolveRunScope } from "../../../contracts/types/codegraph.js";
import { RunScopedMemo } from "./run-scoped-memo.js";

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

/**
 * What {@link AncestorLinearizerCache} reads off a context to decide whether a
 * run's linearizer is still the right one. Structural, like every hierarchy
 * shape in this module, so a `CallContext` satisfies it without being imported.
 */
export interface AncestorLinearizerCacheContext {
  /** The resolve run the context belongs to; absent means detached. */
  readonly runScope?: ResolveRunScope;
  /** The hierarchy channel a linearizer is built over — the entry's key. */
  readonly classAncestors?: object;
  /** The table whose generation stamps the entry. */
  readonly symbolTable?: { size: () => number };
}

/** How an {@link AncestorLinearizerCache} builds a run's linearizer. */
export interface AncestorLinearizerCacheOptions<TCtx, TPolicy extends AncestorLinearizationPolicy<TCtx>> {
  /**
   * A FRESH policy per entry. A policy that memoises (Python's does) must not
   * carry one run's answers into the next, so the cache never shares one.
   */
  readonly createPolicy: () => TPolicy;
  /**
   * Further channels the policy reads beside `classAncestors`, compared by
   * identity. An entry whose companions moved is rebuilt — Ruby's order also
   * reads `classPrependedAncestors` and `classExtends`.
   */
  readonly companionsOf?: (ctx: TCtx) => readonly unknown[];
}

interface AncestorLinearizerCacheEntry<TCtx, TPolicy> {
  readonly table: object;
  readonly size: number;
  readonly companions: readonly unknown[];
  readonly policy: TPolicy;
  readonly linearizer: AncestorLinearizer<TCtx>;
}

const NO_COMPANIONS: readonly unknown[] = Object.freeze([]);

/**
 * The ONE ancestor linearizer a resolve RUN uses (bd tea-rags-mcp-z99hp,
 * generalised from `PythonAncestorLinearizerCache`).
 *
 * A linearizer is bound to the context it was built with and memoises every
 * top-level linearization, so handing it to a later call is only sound while
 * the hierarchy it read cannot have moved. Three things bound that:
 *
 *   - the RUN, through `RunScopedMemo` — a resolver and a pooled symbol table
 *     both outlive a run, and the run-global hierarchy channels are written in
 *     place by the run state, so neither identity alone names a run;
 *   - the identity of `classAncestors` beneath it — the per-file fallback hands
 *     each file its own extraction's hierarchy within one run;
 *   - the symbol table's identity and SIZE, stamped on the entry — pass 1 walks
 *     a table that is still growing while the channels grow beside it, so a
 *     linearization memoised cold must not outlive that growth.
 *
 * `undefined` when the context carries no `classAncestors` or no symbol table:
 * there is nothing to key or stamp an entry by, and the caller keeps its
 * uncached behaviour.
 */
export class AncestorLinearizerCache<
  TCtx extends AncestorLinearizerCacheContext,
  TPolicy extends AncestorLinearizationPolicy<TCtx>,
> {
  private readonly linearizers = new RunScopedMemo<object, AncestorLinearizerCacheEntry<TCtx, TPolicy>>();
  private current: AncestorLinearizerCacheEntry<TCtx, TPolicy> | undefined;

  constructor(private readonly options: AncestorLinearizerCacheOptions<TCtx, TPolicy>) {}

  for(ctx: TCtx): AncestorLinearizer<TCtx> | undefined {
    const ancestors = ctx.classAncestors;
    const table = ctx.symbolTable;
    if (ancestors === undefined || table === undefined) return undefined;
    const size = table.size();
    const companions = this.options.companionsOf?.(ctx) ?? NO_COMPANIONS;
    const existing = this.linearizers.get(ctx.runScope, ancestors);
    const entry =
      existing?.table === table && existing.size === size && sameIdentities(existing.companions, companions)
        ? existing
        : this.build(ctx, ancestors, table, size, companions);
    this.current = entry;
    return entry.linearizer;
  }

  /** The policy of the entry last handed out — the run in flight, or the last one there was. */
  get currentPolicy(): TPolicy | undefined {
    return this.current?.policy;
  }

  private build(
    ctx: TCtx,
    ancestors: object,
    table: object,
    size: number,
    companions: readonly unknown[],
  ): AncestorLinearizerCacheEntry<TCtx, TPolicy> {
    const policy = this.options.createPolicy();
    const fresh: AncestorLinearizerCacheEntry<TCtx, TPolicy> = {
      table,
      size,
      companions,
      policy,
      linearizer: createAncestorLinearizer(ctx, policy),
    };
    this.linearizers.set(ctx.runScope, ancestors, fresh);
    return fresh;
  }
}

function sameIdentities(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
