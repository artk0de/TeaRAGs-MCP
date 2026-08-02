/**
 * `RubyTypeRef` algebra — the ONE place a union / nilable type reference is
 * built, compared, and taken apart (bd tea-rags-mcp-27q0z).
 *
 * Before this bead every channel that carried a return type carried a single
 * nominal name, so a callee yielding a `Firm` on one path and `nil` on another
 * had no honest form: the type sources dropped it and consumers saw silence.
 * `nil` is now an arm like any other, which lets a fact SAY "Firm or nothing"
 * instead of choosing between saying nothing and overstating.
 *
 * The split of duties is deliberate:
 *
 *   - REPRESENTATION keeps the nil arm. Erasing it at construction would make
 *     `Firm|nil` indistinguishable from `Firm`, and a later consumer (the
 *     memoized-tail closure, a nil-guard analysis) could never recover it.
 *   - RESOLUTION drops it. `nil.foo` reaches no in-project definition — Ruby
 *     raises — so the only edges a nilable receiver can produce are the ones its
 *     nominal arms produce. That policy lives in `returnTypeOf`, which is where
 *     "what does calling `m` on this receiver yield" is already decided once.
 *
 * Pure data, no `contracts/` runtime dependency beyond the type itself, so the
 * cycle-sensitive `resolver/type-propagation.ts` can import it freely.
 */
import type { RubyTypeRef } from "../../../contracts/types/language.js";

/** The nil arm — a value that dispatches to nothing. */
export const RUBY_NIL_TYPE_REF: RubyTypeRef = { form: "nil" };

/**
 * Structural equality over every `RubyTypeRef` form. Union arms compare
 * IN ORDER: `rubyUnionOf` fixes a deterministic order at construction, so two
 * refs built from the same facts compare equal, and a hand-built ref that
 * genuinely lists its arms differently is not silently treated as the same
 * statement.
 */
export function rubyTypeRefEquals(a: RubyTypeRef, b: RubyTypeRef): boolean {
  if (a.form !== b.form) return false;
  if (a.form === "nil") return true;
  if (a.form === "container") return rubyTypeRefEquals(a.element, (b as { element: RubyTypeRef }).element);
  if (a.form === "union") {
    const other = (b as { members: readonly RubyTypeRef[] }).members;
    return a.members.length === other.length && a.members.every((m, i) => rubyTypeRefEquals(m, other[i] as RubyTypeRef));
  }
  return a.name === (b as { name: string }).name;
}

/**
 * Build the ref stating "one of these". Nested unions are flattened so arms are
 * always one level deep, structurally equal arms collapse (first occurrence
 * keeps its position), and a list that reduces to a single arm IS that arm — a
 * one-member union is not a union, and leaving one around would make every
 * consumer handle a form that says nothing extra.
 *
 * `undefined` for an empty list: no arms is no statement, which is exactly the
 * silence every type source already uses for "I don't know".
 */
export function rubyUnionOf(members: readonly RubyTypeRef[]): RubyTypeRef | undefined {
  const flat: RubyTypeRef[] = [];
  const push = (ref: RubyTypeRef): void => {
    if (ref.form === "union") {
      for (const inner of ref.members) push(inner);
      return;
    }
    if (flat.some((seen) => rubyTypeRefEquals(seen, ref))) return;
    flat.push(ref);
  };
  for (const member of members) push(member);
  if (flat.length === 0) return undefined;
  if (flat.length === 1) return flat[0];
  return { form: "union", members: flat };
}

/**
 * The arms a call on this receiver could actually dispatch to: the nil arm
 * removed, everything else kept as-is. A non-union ref is its own single arm
 * (or none, when it IS nil), so callers fold over one shape rather than
 * branching on `form` themselves.
 *
 * Container arms are returned untouched — unwrapping an element type is
 * `returnTypeOf`'s job, and doing it here would decide the member semantics in
 * the wrong place.
 */
export function rubyNonNilArms(ref: RubyTypeRef): readonly RubyTypeRef[] {
  if (ref.form === "nil") return [];
  if (ref.form !== "union") return [ref];
  return ref.members.filter((m) => m.form !== "nil");
}

/**
 * The ref a RECEIVER-position consumer should see: a union with exactly one
 * reachable arm collapses to that arm, everything else passes through.
 *
 * This is where the nilable form pays for itself without costing precision.
 * `nil.foo` reaches no in-project definition, so a `Firm|nil` receiver
 * dispatches exactly where a `Firm` receiver does — and the collapse matters
 * because the resolution runner consults `resolveDispatch` BEFORE the exact
 * chain. Left as a union, a nilable receiver would be claimed by
 * `RubyUnionDispatchResolver` and a call that had one exact edge would come back
 * as a one-target `cone` fan-out instead: same target, weaker provenance.
 *
 * A union with TWO reachable arms is untouched — that call really can go two
 * places, and the fan-out is the correct answer. `undefined` when nothing is
 * reachable (an all-nil union, or `nil` itself), which is the same silence an
 * unknown receiver already produces; `undefined` in passes straight through so
 * callers can wrap a lookup without a null-check dance.
 */
export function rubyReceiverForm(ref: RubyTypeRef | undefined): RubyTypeRef | undefined {
  if (ref === undefined) return undefined;
  const arms = rubyNonNilArms(ref);
  if (arms.length === 0) return undefined; // `nil`, or a union of nothing but nil
  // One arm covers both the nilable collapse and every non-union form, which is
  // its own single arm — no branch on `form` needed.
  return arms.length === 1 ? arms[0] : ref;
}
