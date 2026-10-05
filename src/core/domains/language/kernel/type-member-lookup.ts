/**
 * The `TypeMemberLookup` port (bd tea-rags-mcp-m99j1.1.4): "which definition
 * does member `m` on type `T` reach", asked of a language without knowing how
 * that language spells a class key or walks its ancestors.
 *
 * The receiver-typed strategies of every dynamic language ask this one question
 * at their last step — a local binding, a chained return type, a naming
 * convention each arrive at a `TypeRef`, and then need the member on it. The
 * typing differs per strategy; the lookup does not, so it is a port the kernel
 * strategy skeletons consume and each language implements once.
 *
 * The kernel owns the FORM gate, and only that. A `class` / `instance` ref names
 * one type, so it reaches the language lookup. A union is fanned out by its
 * caller (K2), never here — answering one arm of it would be a guess. A tuple,
 * container or nil dispatches to nothing (see `typeRefNonNilArms`). The
 * language side owns the walk: ancestor order, member spelling, file binding.
 */
import type { CallContext, SymbolResolutionTarget } from "../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../contracts/types/language.js";

/** The `TypeRef` forms that name exactly one type a member can be looked up on. */
export type NominalTypeRef = Extract<TypeRef, { form: "class" | "instance" }>;

export interface TypeMemberLookup {
  /**
   * Member `member` on `type`, MRO / ancestor walk included. `class` form =
   * static member, `instance` form = instance member. Union / tuple / container
   * / nil → null: callers fan unions out themselves (K2).
   */
  findMember: (type: TypeRef, member: string, ctx: CallContext) => SymbolResolutionTarget | null;
}

/** Whether a member lookup is defined for `type` at all — the nominal forms only. */
export function typeMemberLookupDefinedFor(type: TypeRef): type is NominalTypeRef {
  return type.form === "class" || type.form === "instance";
}

/**
 * A `TypeMemberLookup` over a language's NOMINAL lookup. `findNominal` sees only
 * `class` / `instance` refs; every other form answers `null` without reaching it.
 */
export function createTypeMemberLookup(
  findNominal: (type: NominalTypeRef, member: string, ctx: CallContext) => SymbolResolutionTarget | null,
): TypeMemberLookup {
  return {
    findMember: (type, member, ctx) => (typeMemberLookupDefinedFor(type) ? findNominal(type, member, ctx) : null),
  };
}
