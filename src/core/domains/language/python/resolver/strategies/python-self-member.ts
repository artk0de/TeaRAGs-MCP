import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import { walkClassExtendsForMethod, type ResolverConfig } from "./shared.js";

/**
 * Intra-class `self.<member>()` — resolution is CONSTRAINED to the enclosing
 * class and its IN-PROJECT base-class chain: try the enclosing class first
 * (direct definition wins), then walk `classExtends` ancestors until one
 * defines `member` (bd tea-rags-mcp-yrs0). A `self` receiver is an instance
 * call on the enclosing class, never a module / import name.
 *
 * **Guard:** when no ancestor in the project defines `member`, DROP rather than
 * fall through to the ambiguous global short-name path (which would attribute
 * the call to any unrelated class that happens to define `<member>`). Mirrors
 * the `super()` walk but starts at the enclosing class itself.
 */
export class PythonSelfMemberSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "selfMember";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "self" || ctx.callerScope.length === 0) return CONTINUE;
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    const target = walkClassExtendsForMethod(enclosing, call.member, ctx, this.cfg.mode);
    // `self` is terminal: a miss is a DROP, not a fall-through (bd yrs0).
    return target ? resolved(target) : DROP;
  }
}
