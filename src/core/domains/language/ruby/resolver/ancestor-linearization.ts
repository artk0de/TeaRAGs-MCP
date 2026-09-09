/**
 * Ruby method-resolution-order linearization (bd tea-rags-mcp-uuux9).
 *
 * The walker records a class's hierarchy as three separate, UNORDERED-relative
 * facts: `classAncestors` (superclass first, then `include`/`extend` mixins in
 * declaration order), `classPrependedAncestors`, and `classExtends`. Read as a
 * flat list, `classAncestors` says nothing reliable about which definition Ruby
 * would actually reach first — its head is the SUPERCLASS, which in Ruby is the
 * FARTHEST of a class's direct ancestors, not the nearest. Every consumer that
 * asks "which definition wins" therefore needs this module rather than the raw
 * list.
 *
 * The driver — the recursion, the per-path guard, the dedupe filter — now lives
 * in `kernel/ancestor-walk.ts`. What stays here is the ORDER, which is Ruby's
 * module-insertion rule and nothing a kernel could guess.
 *
 * ZERO imports beyond that kernel leaf, on purpose. `type-propagation.ts` cannot
 * reach `strategies/shared.ts` (that pulls `walker.ts` → `type-sources/ast-inference`
 * → back into `type-propagation`, a cycle that breaks its top-level const init),
 * so the substrate both sides share has to be a leaf — and `ancestor-walk.ts` is
 * one too, which is why importing it keeps the property rather than spending it.
 * The hierarchy shape is declared structurally here instead of importing
 * `CallContext` for the same reason — a `CallContext` satisfies it by structure.
 */

import { createAncestorLinearizer, type AncestorLinearizationPolicy } from "../../kernel/ancestor-walk.js";

/**
 * The hierarchy facts a linearization needs — the three walker-recorded maps,
 * nothing else. Structural on purpose so a `CallContext` (which carries these
 * plus a symbol table, imports, bindings, …) is accepted without importing it.
 */
export interface RubyAncestorHierarchy {
  /** `class FQ → [superclass?, ...include/extend mixins]`, declaration order. */
  readonly classAncestors?: Readonly<Record<string, readonly string[]>>;
  /** `class FQ → [...prepend mixins]`, declaration order. */
  readonly classPrependedAncestors?: Readonly<Record<string, readonly string[]>>;
  /** `class FQ → superclass FQ` — the one entry of `classAncestors` that is a `<`. */
  readonly classExtends?: Readonly<Record<string, string>>;
}

/**
 * Ruby's answer to "which ancestor is nearest" — the ORDER half of the walk,
 * handed to the kernel driver, which supplies the recursion, the per-path cycle
 * guard, and the dedupe filter that `insertable` closes over.
 */
const RUBY_ANCESTOR_POLICY: AncestorLinearizationPolicy<RubyAncestorHierarchy> = {
  order(klass, hierarchy, recurse, insertable) {
    // The superclass chain is built FIRST: in Ruby it already exists when the
    // class body runs, so it is what every `include`/`prepend` in that body checks
    // itself against before inserting.
    const superclass = hierarchy.classExtends?.[klass];
    const tail = superclass === undefined ? [] : recurse(superclass);

    // Includes, declaration order, each inserted at the FRONT of the region — so
    // the last one declared ends up nearest, as Ruby ranks them.
    const includes: string[] = [];
    for (const mixin of hierarchy.classAncestors?.[klass] ?? []) {
      if (mixin === superclass) continue; // already carried by `tail`
      includes.unshift(...insertable(mixin, [includes, tail]));
    }

    // Prepends, same insertion rule, but the region sits BEFORE the class itself.
    const prepends: string[] = [];
    for (const mixin of hierarchy.classPrependedAncestors?.[klass] ?? []) {
      prepends.unshift(...insertable(mixin, [prepends, includes, tail]));
    }

    return [...prepends, klass, ...includes, ...tail];
  },
};

/**
 * `klass`'s ancestors in Ruby's method-lookup order, NEAREST FIRST, with `klass`
 * itself at its true position. The answer to "which of these definitions does a
 * call reach" is simply the first entry that has one.
 *
 * The rule, which is Ruby's module-insertion semantics rather than a general C3
 * merge (Ruby has no multiple inheritance to merge):
 *
 *   `[...prepends, klass, ...includes, ...superclass chain]`
 *
 * with each mixin expanded by the same rule, and within the prepend and include
 * regions the LAST declaration sitting NEAREST — `include A; include B` yields
 * `[C, B, A]`, because each `include` inserts at the front of the region.
 *
 * **Dedup: first occurrence wins.** A module already reachable is not inserted
 * again, which is exactly what Ruby does — `include M` on a class whose
 * superclass already carries M is a no-op, and M stays BEHIND the superclass
 * instead of being hoisted in front of it. That is why the superclass chain is
 * linearized FIRST and the mixin regions are filtered against it: the order the
 * regions are built in is what makes the no-op land in the right place.
 *
 * Cycles in the extracted data (`A < B; B < A`) terminate via a per-PATH guard.
 * Per-path rather than shared: a module reached down two different branches must
 * expand on both, otherwise whichever branch ran second would silently lose its
 * tail.
 *
 * `extend` mixins are conflated with `include` here because the walker already
 * conflates them in `classAncestors`; separating the singleton-class chain is a
 * different axis and not this function's business.
 */
export function linearizeAncestors(klass: string, hierarchy: RubyAncestorHierarchy): string[] {
  // A FRESH linearizer per call, deliberately: today's `linearize` cached
  // nothing, and a longer-lived memo would have to prove it cannot outlive a
  // mutation of the run-global ancestors map. Ruby pays one extra Map
  // allocation per call and gains nothing else; Python's long-lived linearizer
  // is built once per resolver, where the memo is what makes the walk affordable.
  return [...createAncestorLinearizer(hierarchy, RUBY_ANCESTOR_POLICY).linearize(klass).order];
}
