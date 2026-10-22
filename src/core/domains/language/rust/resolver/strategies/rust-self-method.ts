import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { rustCallerCrateUniqueType, rustCrateRootOf, rustCrateTypeMembers } from "../rust-crate-scope.js";
import { lookupEnclosingMember, type ResolverConfig } from "./shared.js";

/**
 * bd tea-rags-mcp-c5by — `self.method()` intra-impl call. Resolve to
 * `<enclosingType>#method` (instance) or `<enclosingType>.method` (associated
 * function) constrained to the caller's own file before falling through to
 * import / global short-name resolution. Mirrors the Java resolver's
 * `this.X()` branch — without this, `self.clone()` grabs the FIRST `clone`
 * from the symbol table (e.g. `Error#clone`) and produces cross-receiver
 * garbage edges.
 *
 * A same-file miss asks the enclosing type's CRATE (bd tea-rags-mcp-s3i8m
 * Task 2): Rust keeps inherent impls inside the defining crate, so a type name
 * unique there owns every `T#m` / `T.m` the crate declares in any file. A sole
 * candidate resolves; several (an inherent and a trait impl both defining `m`)
 * or none continue — never a pick, never a drop.
 */
export class RustSelfMethodSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "selfMethod";
  // Same-file and crate-unique lookups only — no ambiguous-mode pick.
  constructor(_cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "self" || ctx.callerScope.length === 0) return CONTINUE;
    const sameFileHit = lookupEnclosingMember(call.member, ctx);
    if (sameFileHit) return resolved(sameFileHit);
    return this.attemptCrateScoped(call.member, ctx);
  }

  private attemptCrateScoped(member: string, ctx: CallContext): SymbolResolutionOutcome {
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    const owner = rustCallerCrateUniqueType(enclosing, ctx);
    const root = owner === undefined ? undefined : rustCrateRootOf(owner.relPath, ctx);
    if (root === undefined) return CONTINUE;
    for (const separator of ["#", "."] as const) {
      const candidates = rustCrateTypeMembers(enclosing, separator, member, root, ctx);
      if (candidates.length === 1) {
        return resolved({ targetRelPath: candidates[0].relPath, targetSymbolId: candidates[0].symbolId });
      }
      if (candidates.length > 1) return CONTINUE;
    }
    return CONTINUE;
  }
}
