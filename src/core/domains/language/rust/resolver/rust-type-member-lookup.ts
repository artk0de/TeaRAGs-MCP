/** Rust nominal type member lookup for the reusable kernel receiver strategies. */

import type { AmbiguousResolveMode, CallContext, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import { createTypeMemberLookup, type NominalTypeRef, type TypeMemberLookup } from "../../kernel/index.js";
import { rustDerefTarget, rustExactMember } from "./declared-return-type.js";
import { rustStdSmartPointerTarget } from "./std-type-hops.js";
import { lookupRustSymbolsByShortName, pickSameFileThenSingle } from "./strategies/shared.js";

/**
 * Rust's `Type::member` and `receiver.member` share the same nominal member
 * table. The symbol-id convention distinguishes instance (`#`) and associated
 * (`.`) members; lookup keeps the historical instance-first order and prefers
 * a same-file declaration when a type name is duplicated across crates.
 *
 * A member every owner misses derefs: Rust's own method resolution follows
 * `Deref` targets, so `d.paint()` on a project `Dom<Window>` resolves on
 * `Window` (bd tea-rags-mcp-2g2og). Three hops with a name cycle guard —
 * `Root<Dom<T>>` derefs twice; `member === "deref"` never walks itself.
 */
export function createRustTypeMemberLookup(mode: AmbiguousResolveMode): TypeMemberLookup {
  return createTypeMemberLookup((typeRef, member, ctx) => resolveRustNominalMember(typeRef, member, ctx, mode));
}

/** The raw nominal-member walk (auto-deref included) for callers outside the kernel strategies. */
export function resolveRustMemberWithDeref(
  typeRef: NominalTypeRef,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): { targetRelPath: string; targetSymbolId: string } | null {
  return resolveRustNominalMember(typeRef, member, ctx, mode);
}

function resolveRustNominalMember(owner: NominalTypeRef, member: string, ctx: CallContext, mode: AmbiguousResolveMode) {
  let current = owner;
  for (let hop = 0; hop < 3; hop++) {
    const hit = resolveRustNominalMemberOn(current, member, ctx, mode);
    if (hit !== null) return hit;
    if (member === "deref") return null;
    // A std smart pointer (`Arc<Core>`) derefs to its target for every member
    // it does not answer itself (bd tea-rags-mcp-2g2og.24).
    const pointee = rustStdSmartPointerTarget(current, member);
    const next = pointee?.form === "instance" ? pointee : rustDerefTarget(current, ctx);
    if (next === undefined || next.name === current.name) return null;
    current = next;
  }
  return null;
}

function resolveRustNominalMemberOn(
  owner: NominalTypeRef,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
) {
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
