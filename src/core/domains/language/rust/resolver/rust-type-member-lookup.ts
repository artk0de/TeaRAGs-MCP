/** Rust nominal type member lookup for the reusable kernel receiver strategies. */

import type { AmbiguousResolveMode, CallContext, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import { createTypeMemberLookup, type NominalTypeRef, type TypeMemberLookup } from "../../kernel/index.js";
import { rustExactMember } from "./declared-return-type.js";
import { lookupRustSymbolsByShortName, pickSameFileThenSingle } from "./strategies/shared.js";

/**
 * Rust's `Type::member` and `receiver.member` share the same nominal member
 * table. The symbol-id convention distinguishes instance (`#`) and associated
 * (`.`) members; lookup keeps the historical instance-first order and prefers
 * a same-file declaration when a type name is duplicated across crates.
 */
export function createRustTypeMemberLookup(mode: AmbiguousResolveMode): TypeMemberLookup {
  return createTypeMemberLookup((typeRef, member, ctx) => resolveRustNominalMember(typeRef, member, ctx, mode));
}

function resolveRustNominalMember(owner: NominalTypeRef, member: string, ctx: CallContext, mode: AmbiguousResolveMode) {
  if (owner.name.includes(".rs::")) {
    const hit = rustExactMember(owner, member, ctx);
    return hit === undefined ? null : { targetRelPath: hit.relPath, targetSymbolId: hit.symbolId };
  }
  const typeName = owner.name;
  const candidates = lookupRustSymbolsByShortName(ctx, member);
  for (const separator of ["#", "."] as const) {
    const own = candidates.filter((def) => isRustTypeMember(def.symbolId, typeName, separator, member));
    const hit = pickSameFileThenSingle(own, ctx.callerFile, mode);
    if (hit) return { targetRelPath: hit.relPath, targetSymbolId: hit.symbolId };
  }
  return null;
}

function isRustTypeMember(
  symbolId: SymbolDefinition["symbolId"],
  typeName: string,
  separator: "#" | ".",
  member: string,
): boolean {
  const own = `${typeName}${separator}${member}`;
  return symbolId === own || symbolId.endsWith(`::${own}`);
}
