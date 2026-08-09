/**
 * What calling a member on a typed receiver yields — the five-channel authority.
 *
 * {@link returnTypeOf} is the ONE place the channel precedence is written down:
 * declared structured fact, Rails association DSL, ancestor MRO, the flat
 * owner-less `functionReturnTypes` map, then ActiveRecord query vocabulary. The
 * order is load-bearing and each guard closes a named bug — do not reorder it,
 * and do not add a channel without measuring `resolveSuccessRate` /
 * `inProjectEdgeRecall` on a real corpus.
 *
 * The container vocabularies live here too: {@link CONTAINER_ELEMENT_RETURNING_METHODS}
 * is the unwrap set {@link returnTypeOf} applies to a `container` receiver, and
 * {@link CONTAINER_BLOCK_ITERATION_METHODS} is its walk-time sibling for block
 * parameters. Both are re-exported by `type-propagation.ts`, which is the
 * address every consumer imports them from.
 *
 * Split out of `type-propagation.ts` (bd tea-rags-mcp-uetqq) with channel order,
 * guards and vocabulary byte-identical.
 */

import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../contracts/types/language.js";
import { rubyNonNilArms, rubyTypeRefEquals } from "../type-ref.js";
import { activeRecordQueryReturn } from "./ruby-active-record-return-types.js";
import {
  declaredReturnTypeOn,
  flatReturnFactMayOverrideKnownReceiver,
  inheritedReturnType,
} from "./ruby-return-facts.js";

/**
 * Array/Enumerable methods that return a SINGLE ELEMENT from a typed container.
 * When `recv` is `{form:"container", element:E}` and the member is in this set,
 * `returnTypeOf` unwraps the container and returns `E` so multi-hop chains like
 * `posts.first.title` thread correctly: posts→container(Post), .first→Post,
 * .title→Post#title.
 *
 * Non-element methods (`size`, `count`, `map`, `length`) are intentionally
 * absent — those operate on the container itself (Array/Enumerable = external)
 * and their return types are not trackable without a full Enumerable type model.
 */
export const CONTAINER_ELEMENT_RETURNING_METHODS = new Set([
  "first",
  "last",
  "[]",
  "fetch",
  "sample",
  "find",
  "detect",
  "min",
  "max",
  "dig",
]);

/**
 * Block-iteration methods whose FIRST block parameter is bound to the container's
 * element type at walk-time. When `recv` has a known container element type E,
 * `posts.each { |p| … }` binds `p` to `E`. This constant is the single source
 * of truth for the block-param inference set (bd Increment B / B-block) used by
 * both `rubyAstInferenceTypeSource` (via the `latestBinding` seed) and
 * `collectLocalBindingsForChunk` (via `RUBY_BLOCK_ITERATOR_METHODS`).
 *
 * Exported here so the engine and the walker share one definition; the walker's
 * `RUBY_BLOCK_ITERATOR_METHODS` re-exports this.
 */
export const CONTAINER_BLOCK_ITERATION_METHODS = new Set([
  "each",
  "map",
  "collect",
  "select",
  "filter",
  "filter_map",
  "reject",
  "find",
  "detect",
  "find_all",
  "flat_map",
  "each_with_index",
  "each_with_object",
  "group_by",
  "sort_by",
  "min_by",
  "max_by",
  "partition",
]);

/**
 * The ONE authority for "what type does calling `member` on a receiver of type
 * `recv` yield" (bd tea-rags-mcp-j9xpf — same single-authority discipline as
 * `ivarTypeName`). Every reader — the chain engine's hop walk and the
 * `returnTypeBinding` pass's scope-qualified lookup — MUST go through here, so
 * the channel precedence below is stated once and cannot drift between callers.
 *
 * Resolution order (first non-undefined wins):
 * 1. `ctx.structuredReturnTypes?.["${recv.name}#${member}"]` — precise structured ref.
 * 2. `ctx.associationTypes?.[recv.name]?.[member]` → `{form:"instance", name}` —
 *    Rails belongs_to / has_many / has_one DSL associations.
 * 3. Ancestor MRO: walk `ctx.classAncestors?.[recv.name]` for an inherited
 *    `structuredReturnTypes["${ancestor}#${member}"]`.
 * 4. `ctx.functionReturnTypes?.[member]` → `{form:"instance", name}` — flat
 *    fallback (YARD @return map, already populated today). Applied LAST so the
 *    more-precise paths win when available, and only for a member the corpus
 *    does not multiply define (see {@link flatReturnFactMayOverrideKnownReceiver}) — the
 *    map carries no owning class, so an ambiguous name makes it a guess about
 *    a receiver whose class is already known.
 * 5. ActiveRecord query interface (G1b) — consulted AFTER every declared fact
 *    (a declared type beats vocabulary), gated on the AR-model check.
 *
 * Container element-returning methods unwrap to the element type (Task 1.6).
 * A UNION receiver folds over its arms (bd tea-rags-mcp-27q0z, see below).
 */
export function returnTypeOf(recv: RubyTypeRef, member: string, ctx: CallContext): RubyTypeRef | undefined {
  // Container form: element-returning methods unwrap to the element type (Task 1.6).
  // Non-element methods (size, count, map, …) → undefined (Array/Enumerable = external).
  if (recv.form === "container") {
    return CONTAINER_ELEMENT_RETURNING_METHODS.has(member) ? recv.element : undefined;
  }

  // Union / nil receiver: the agreement fold (bd tea-rags-mcp-27q0z).
  if (recv.form === "union" || recv.form === "nil") return unionReturnType(recv, member, ctx);

  // 1. Precise structured return type for this class#member key.
  const direct = declaredReturnTypeOn(recv.name, member, ctx, recv.form === "class");
  if (direct !== undefined) return direct;

  // 2. Rails association DSL: associationTypes[className][accessorName] → modelName.
  //    INSTANCE receivers only — `belongs_to :firm` defines `#firm` on instances,
  //    never on the class object, so `SomeClass.firm` is a different method that
  //    must fall through to the scoped/flat return channels below (j9xpf: without
  //    this guard a class-form receiver silently borrows an instance accessor's
  //    type and shadows the correct one).
  if (recv.form === "instance") {
    const assocName = ctx.associationTypes?.[recv.name]?.[member];
    if (assocName !== undefined) return { form: "instance", name: assocName };
  }

  // 3. Ancestor MRO: walk classAncestors[recv.name] for an inherited return type.
  const inherited = inheritedReturnType(recv.name, member, ctx, recv.form === "class");
  if (inherited !== undefined) return inherited;

  // 4. Flat functionReturnTypes fallback — YARD @return map, populated today.
  //    Owner-less, so it answers only for a member the corpus does not multiply
  //    define (bd tea-rags-mcp-h4hxh).
  const flatName = ctx.functionReturnTypes?.[member];
  if (flatName !== undefined && flatReturnFactMayOverrideKnownReceiver(member, ctx)) {
    return { form: "instance", name: flatName };
  }

  // 5. ActiveRecord query-interface vocabulary — AR-model receivers only,
  //    consulted last so every declared fact above wins over it (G1b).
  return activeRecordQueryReturn(recv.name, member, ctx);
}

/**
 * What calling `member` on a UNION (or `nil`) receiver yields
 * (bd tea-rags-mcp-27q0z) — the resolution half of the nilable substrate, kept
 * beside {@link returnTypeOf} because it is that function's union case and
 * shares its channel precedence by construction (it RECURSES into it per arm).
 *
 * Two rules, and both of them are about not guessing:
 *
 *  - the `nil` arm is DROPPED. `nil.foo` reaches no in-project definition —
 *    Ruby raises — so a nilable receiver can only ever produce the edges its
 *    nominal arms produce. This is what lets a `Firm`-or-`nil` fact be stated
 *    honestly at the source and still thread like a plain `Firm` here.
 *  - the remaining arms must AGREE. Every arm answering the same type is the
 *    only case where the answer holds no matter which arm the value actually
 *    was; one silent arm or two different answers is a question this map cannot
 *    settle, and a wrong receiver type poisons every downstream hop. Same
 *    conservatism, same reason, as `selfMemberReturnType`'s disagreeing
 *    ancestors.
 *
 * A union of nothing but `nil` therefore answers `undefined`, exactly as a bare
 * `nil` receiver does.
 */
function unionReturnType(recv: RubyTypeRef, member: string, ctx: CallContext): RubyTypeRef | undefined {
  let agreed: RubyTypeRef | undefined;
  for (const arm of rubyNonNilArms(recv)) {
    const armReturn = returnTypeOf(arm, member, ctx);
    if (armReturn === undefined) return undefined; // a silent arm silences the fold
    if (agreed === undefined) agreed = armReturn;
    else if (!rubyTypeRefEquals(agreed, armReturn)) return undefined; // arms disagree
  }
  return agreed;
}
