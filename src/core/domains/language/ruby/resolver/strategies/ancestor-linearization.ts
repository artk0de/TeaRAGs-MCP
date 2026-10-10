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

import { identifierEntry } from "../../../../../contracts/identifier-record.js";
import type { HierarchyView } from "../../../../../contracts/types/codegraph-hierarchy.js";
import type { RubyExtendedHookMixin } from "../../../../../contracts/types/codegraph.js";
import {
  AncestorLinearizerCache,
  createAncestorLinearizer,
  type AncestorLinearizationPolicy,
  type AncestorLinearizerCacheContext,
} from "../../../kernel/index.js";

/**
 * The hierarchy facts a linearization needs — the three walker-recorded maps,
 * plus the run scope and symbol table the kernel cache keys and stamps an entry
 * by. Structural on purpose so a `CallContext` (which carries these plus
 * imports, bindings, …) is accepted without importing it.
 */
export interface RubyAncestorHierarchy extends AncestorLinearizerCacheContext {
  /** `class FQ → [superclass?, ...include/extend mixins]`, declaration order. */
  readonly classAncestors?: Readonly<Record<string, readonly string[]>>;
  /** `class FQ → [...prepend mixins]`, declaration order. */
  readonly classPrependedAncestors?: Readonly<Record<string, readonly string[]>>;
  /** `class FQ → superclass FQ` — the one entry of `classAncestors` that is a `<`. */
  readonly classExtends?: Readonly<Record<string, string>>;
  /**
   * The kind-precise hierarchy (`super` / `include` / `extend` / `prepend`), read
   * only to tell which `classAncestors` entries a class merely `extend`s — see
   * {@link singletonOnlyMixinsOf}. Absent ⇒ every entry counts on both sides.
   */
  readonly hierarchy?: HierarchyView;
  /**
   * `module FQ → what its self.extended hook includes / prepends into the
   * extender`, read only on the instance side, where a singleton-only `extend M`
   * is replaced by M's hook injections — see {@link rubyDirectAncestors}.
   */
  readonly extendedHookMixins?: Readonly<Record<string, readonly RubyExtendedHookMixin[]>>;
  /** FQs declared compact (`class A::B::C`) — they open no intermediate namespace. */
  readonly compactDeclaredClasses?: ReadonlySet<string>;
}

/**
 * Which `self` a member lookup dispatches on (bd tea-rags-mcp-89k7k.35.31).
 *
 *   - `"instance"` — `self` is an instance (a `#` method, a receiver built by
 *     `X.new`). Ruby walks the class's own ancestry: superclass + `include` +
 *     `prepend`. A module the class only `extend`s sits on the singleton class
 *     and is invisible here.
 *   - `"unscoped"` — the class object, a class/module body, or a caller whose
 *     form is unknown. Walks the flat walker list as it always has, `extend`ed
 *     modules included, so every class-side lookup keeps its answer.
 */
export type RubyAncestrySide = "instance" | "unscoped";

/**
 * Which `self` a receiverless, `self.` or `super` call dispatches on, read off
 * the caller's own symbolId. An instance method (`Klass#render` — its LAST
 * method separator is `#`) runs with an instance `self`: `"instance"`. A class
 * method (`Klass.build`, `class << self` bodies included), a class/module-body
 * chunk, an RSpec scope (`describe "#x".it "y"`) or an unknown caller answers
 * `"unscoped"`. A chunker split suffix (`#partN`) is not a method separator.
 */
export function callerAncestrySide(caller: { readonly callerSymbolId?: string }): RubyAncestrySide {
  const symbolId = caller.callerSymbolId?.replace(/#part\d+$/, "");
  if (symbolId === undefined) return "unscoped";
  return symbolId.lastIndexOf("#") > symbolId.lastIndexOf(".") ? "instance" : "unscoped";
}

const NO_SINGLETON_ONLY_MIXINS: ReadonlySet<string> = new Set();

/**
 * The modules `klass` mixes in with `extend` and with nothing else — no
 * `include`, `prepend` or `<` row from `klass` names them. Those are the
 * `classAncestors` entries an INSTANCE lookup must skip. Read off the
 * hierarchy's direct rows, which every reopening of `klass` contributes to, so
 * an `extend` in one file and an `include` of the same module in another keep
 * the module. Rows carry the mixin as the site wrote it — the same raw text
 * `classAncestors` stores — so the two compare as strings.
 */
export function singletonOnlyMixinsOf(klass: string, hierarchy: RubyAncestorHierarchy): ReadonlySet<string> {
  const rows = hierarchy.hierarchy?.getAncestors(klass);
  if (rows === undefined || rows.length === 0) return NO_SINGLETON_ONLY_MIXINS;
  let extended: Set<string> | undefined;
  for (const row of rows) {
    if (row.sourceFqName === klass && row.kind === "extend") (extended ??= new Set()).add(row.ancestorFqName);
  }
  if (extended === undefined) return NO_SINGLETON_ONLY_MIXINS;
  for (const row of rows) {
    if (row.sourceFqName === klass && row.kind !== "extend") extended.delete(row.ancestorFqName);
  }
  return extended;
}

const NO_HOOK_MIXINS: readonly RubyExtendedHookMixin[] = [];

/**
 * What the `self.extended` hook of the module `klass`'s body names `raw`
 * injects into `klass`. `raw` is the mixin as the site wrote it, so it is read
 * the way Ruby reads a constant there — `klass`'s own namespace, the top level,
 * then each enclosing namespace innermost first (none for a COMPACT
 * declaration) — and the first spelling the hook map keys answers. The hook
 * map holds only modules that declare a hook, so a miss is "no hook".
 */
function extendedHookMixinsOf(
  raw: string,
  klass: string,
  hierarchy: RubyAncestorHierarchy,
): readonly RubyExtendedHookMixin[] {
  const hooks = hierarchy.extendedHookMixins;
  if (hooks === undefined) return NO_HOOK_MIXINS;
  const candidates = [`${klass}::${raw}`, raw];
  if (!hierarchy.compactDeclaredClasses?.has(klass)) {
    const segments = klass.split("::");
    for (let i = segments.length - 1; i >= 1; i--) candidates.push(`${segments.slice(0, i).join("::")}::${raw}`);
  }
  for (const candidate of candidates) {
    const mixins = identifierEntry(hooks, candidate);
    if (mixins !== undefined) return mixins;
  }
  return NO_HOOK_MIXINS;
}

/**
 * `klass`'s direct `classAncestors` entries as a lookup on `side` sees them.
 * `"unscoped"` reads the flat walker list. `"instance"` drops every module
 * `klass` only `extend`s and puts, AT that module's position, what the
 * module's `self.extended` hook `include`s into `klass` — Ruby runs the hook
 * right where `extend` runs, so its includes rank as if declared there (bd
 * tea-rags-mcp-89k7k.35.31). Hook PREPENDS go to {@link rubyDirectPrepends}.
 * `undefined` exactly when the walker recorded no entry for `klass`.
 */
export function rubyDirectAncestors(
  klass: string,
  hierarchy: RubyAncestorHierarchy,
  side: RubyAncestrySide,
): readonly string[] | undefined {
  const ancestors = identifierEntry(hierarchy.classAncestors, klass);
  if (ancestors === undefined || side === "unscoped") return ancestors;
  const singletonOnly = singletonOnlyMixinsOf(klass, hierarchy);
  if (singletonOnly.size === 0) return ancestors;
  return ancestors.flatMap((ancestor) =>
    singletonOnly.has(ancestor)
      ? extendedHookMixinsOf(ancestor, klass, hierarchy)
          .filter((mixin) => mixin.kind === "include")
          .map((mixin) => mixin.module)
      : [ancestor],
  );
}

/**
 * `klass`'s direct `prepend`s as a lookup on `side` sees them: the walker's
 * `classPrependedAncestors`, and on the `"instance"` side also what the hook of
 * each singleton-only `extend`ed module prepends into `klass` (bd
 * tea-rags-mcp-89k7k.35.31), after the class's own in declaration order —
 * later = nearer, as the walker list reads.
 */
export function rubyDirectPrepends(
  klass: string,
  hierarchy: RubyAncestorHierarchy,
  side: RubyAncestrySide,
): readonly string[] | undefined {
  const prepended = identifierEntry(hierarchy.classPrependedAncestors, klass);
  if (side === "unscoped" || hierarchy.extendedHookMixins === undefined) return prepended;
  const singletonOnly = singletonOnlyMixinsOf(klass, hierarchy);
  if (singletonOnly.size === 0) return prepended;
  const hookPrepends = [...singletonOnly].flatMap((module) =>
    extendedHookMixinsOf(module, klass, hierarchy)
      .filter((mixin) => mixin.kind === "prepend")
      .map((mixin) => mixin.module),
  );
  if (hookPrepends.length === 0) return prepended;
  return [...(prepended ?? []), ...hookPrepends];
}

/**
 * Ruby's answer to "which ancestor is nearest" on one {@link RubyAncestrySide} —
 * the ORDER half of the walk, handed to the kernel driver, which supplies the
 * recursion, the per-path cycle guard, and the dedupe filter that `insertable`
 * closes over. The side filters every hop, so a superclass's `extend` stays off
 * a subclass instance's order too.
 */
function rubyAncestorPolicy(side: RubyAncestrySide): AncestorLinearizationPolicy<RubyAncestorHierarchy> {
  return {
    order(klass, hierarchy, recurse, insertable) {
      // The superclass chain is built FIRST: in Ruby it already exists when the
      // class body runs, so it is what every `include`/`prepend` in that body checks
      // itself against before inserting.
      const superclass = identifierEntry(hierarchy.classExtends, klass);
      const tail = superclass === undefined ? [] : recurse(superclass);

      // Includes, declaration order, each inserted at the FRONT of the region — so
      // the last one declared ends up nearest, as Ruby ranks them.
      const includes: string[] = [];
      for (const mixin of rubyDirectAncestors(klass, hierarchy, side) ?? []) {
        if (mixin === superclass) continue; // already carried by `tail`
        includes.unshift(...insertable(mixin, [includes, tail]));
      }

      // Prepends, same insertion rule, but the region sits BEFORE the class itself.
      const prepends: string[] = [];
      for (const mixin of rubyDirectPrepends(klass, hierarchy, side) ?? []) {
        prepends.unshift(...insertable(mixin, [prepends, includes, tail]));
      }

      return [...prepends, klass, ...includes, ...tail];
    },
  };
}

/** The flat-list order every class-side and form-unknown caller reads. */
const RUBY_ANCESTOR_POLICY = rubyAncestorPolicy("unscoped");

/** The instance order: superclass + `include` + `prepend`, singleton-only mixins left out. */
const RUBY_INSTANCE_ANCESTOR_POLICY = rubyAncestorPolicy("instance");

/**
 * Ruby's run-scoped linearizer caches (bd tea-rags-mcp-m99j1.1.7), one per side.
 * Ruby's policies are stateless, so every entry shares its side's policy; the
 * entry exists for the linearizer's per-class memo. The order also reads the
 * prepend and superclass maps — and, on the instance side, the kind-precise
 * hierarchy — so a context that swaps any of them is a different entry.
 */
const RUBY_ANCESTOR_LINEARIZER_CACHE = new AncestorLinearizerCache<
  RubyAncestorHierarchy,
  AncestorLinearizationPolicy<RubyAncestorHierarchy>
>({
  createPolicy: () => RUBY_ANCESTOR_POLICY,
  companionsOf: (hierarchy) => [hierarchy.classPrependedAncestors, hierarchy.classExtends],
});

const RUBY_INSTANCE_ANCESTOR_LINEARIZER_CACHE = new AncestorLinearizerCache<
  RubyAncestorHierarchy,
  AncestorLinearizationPolicy<RubyAncestorHierarchy>
>({
  createPolicy: () => RUBY_INSTANCE_ANCESTOR_POLICY,
  companionsOf: (hierarchy) => [
    hierarchy.classPrependedAncestors,
    hierarchy.classExtends,
    hierarchy.hierarchy,
    hierarchy.extendedHookMixins,
    hierarchy.compactDeclaredClasses,
  ],
});

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
 * `side` says which `self` the order is for (bd tea-rags-mcp-89k7k.35.31). On
 * the `"instance"` side a module the class only `extend`s is left out — it sits
 * on the singleton class. `"unscoped"`, the default, keeps the flat walker list,
 * where `extend` mixins rank like includes: the view every class-side and
 * form-unknown caller has always read.
 */
export function linearizeAncestors(
  klass: string,
  hierarchy: RubyAncestorHierarchy,
  side: RubyAncestrySide = "unscoped",
): string[] {
  // The run's linearizer whenever the hierarchy names one: `ancestorsInMroOrder`
  // asks this once per hop of every member walk, against a hierarchy that does
  // not move between those asks. The proof that the memo cannot outlive a
  // mutation of the run-global maps is the kernel cache's — run scope,
  // `classAncestors` identity, table generation, and the two companion maps
  // below. A hierarchy with nothing to key or stamp an entry by gets a fresh
  // linearizer, which is what every call got before the cache.
  const [cache, policy] =
    side === "instance"
      ? [RUBY_INSTANCE_ANCESTOR_LINEARIZER_CACHE, RUBY_INSTANCE_ANCESTOR_POLICY]
      : [RUBY_ANCESTOR_LINEARIZER_CACHE, RUBY_ANCESTOR_POLICY];
  const linearizer = cache.for(hierarchy) ?? createAncestorLinearizer(hierarchy, policy);
  return [...linearizer.linearize(klass).order];
}
