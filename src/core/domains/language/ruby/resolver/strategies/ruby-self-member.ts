import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { resolveInstanceMethodInClassChain, type ResolverConfig } from "./shared.js";

/**
 * Explicit `self.<member>` (bd tea-rags-mcp-kh9vo). The walker emits these with
 * a literal `self` receiver (it only normalises `self` to `null` on the
 * dynamic-dispatch `send`/`public_send` path, not on direct `self.foo` calls).
 * A `self` receiver is an instance call on the ENCLOSING class — never a module
 * or import name — so resolution is constrained to that class and its in-project
 * ancestor chain (`classAncestors`): try the enclosing class first (a direct
 * definition wins), then walk superclass + `include`/`extend` mixins until one
 * defines `member`. Reuses the shared `resolveInstanceMethodInClassChain` walk
 * (the same MRO traversal the `super` pass uses) so the inheritance logic lives
 * once.
 *
 * **Guard:** like `super`, `self` is terminal. When no class in the chain
 * defines `member`, DROP rather than fall through to the ambiguous global
 * short-name path (which would attribute the call to any unrelated class that
 * happens to define `<member>` — the exact false-positive family as bd lttd).
 * A file-only edge (`targetSymbolId: null`) still counts as resolved when the
 * enclosing/ancestor file is known but the method lives outside the project.
 *
 * MUST run BEFORE `receiverSetDrop`: that guard drops any receiver-set call
 * (`receiver !== null`), which would otherwise swallow every `self.foo` before
 * this pass sees it (the 0-of-130 symptom this strategy fixes).
 */
export class RubySelfMemberSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "selfMember";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "self" || ctx.callerScope.length === 0) return CONTINUE;
    // FQ key matches `collectRubyClassAncestors` output: nested classes become
    // `Outer::Inner` via scope-stack join with `::` (parity with the super walk).
    const enclosingClass = ctx.callerScope.join("::");
    const target = resolveInstanceMethodInClassChain(enclosingClass, call.member, ctx, this.cfg.mode, new Set());
    // `self` is terminal: a miss is a DROP, not a fall-through (bd kh9vo, same
    // family as the super-keyword guard bd jsa0/lttd).
    return target ? resolved(target) : DROP;
  }
}
