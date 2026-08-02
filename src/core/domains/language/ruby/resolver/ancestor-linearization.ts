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
 * ZERO imports on purpose. `type-propagation.ts` cannot reach
 * `strategies/shared.ts` (that pulls `walker.ts` → `type-sources/ast-inference`
 * → back into `type-propagation`, a cycle that breaks its top-level const init),
 * so the substrate both sides share has to be a leaf. The hierarchy shape is
 * declared structurally here instead of importing `CallContext` for the same
 * reason — a `CallContext` satisfies it by structure.
 */

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
  return linearize(klass, hierarchy, new Set());
}

function linearize(klass: string, hierarchy: RubyAncestorHierarchy, path: ReadonlySet<string>): string[] {
  if (path.has(klass)) return [];
  const nextPath = new Set(path).add(klass);

  // The superclass chain is built FIRST: in Ruby it already exists when the
  // class body runs, so it is what every `include`/`prepend` in that body checks
  // itself against before inserting.
  const superclass = hierarchy.classExtends?.[klass];
  const tail = superclass === undefined ? [] : linearize(superclass, hierarchy, nextPath);

  // Includes, declaration order, each inserted at the FRONT of the region — so
  // the last one declared ends up nearest, as Ruby ranks them.
  const includes: string[] = [];
  for (const mixin of hierarchy.classAncestors?.[klass] ?? []) {
    if (mixin === superclass) continue; // already carried by `tail`
    includes.unshift(...insertable(mixin, hierarchy, nextPath, [includes, tail]));
  }

  // Prepends, same insertion rule, but the region sits BEFORE the class itself.
  const prepends: string[] = [];
  for (const mixin of hierarchy.classPrependedAncestors?.[klass] ?? []) {
    prepends.unshift(...insertable(mixin, hierarchy, nextPath, [prepends, includes, tail]));
  }

  return [...prepends, klass, ...includes, ...tail];
}

/**
 * The entries of `mixin`'s own linearization that are not already reachable
 * through any of `present` — Ruby's "a module already in the chain is not
 * re-inserted" rule, applied to the whole module rather than to its head.
 */
function insertable(
  mixin: string,
  hierarchy: RubyAncestorHierarchy,
  path: ReadonlySet<string>,
  present: readonly (readonly string[])[],
): string[] {
  return linearize(mixin, hierarchy, path).filter((name) => !present.some((region) => region.includes(name)));
}
