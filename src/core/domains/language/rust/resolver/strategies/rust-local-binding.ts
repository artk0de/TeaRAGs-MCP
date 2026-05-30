import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import { pickSameFileThenSingle, type ResolverConfig } from "./shared.js";

/**
 * bd tea-rags-mcp-c5by — when `localBindings` type-binds the receiver to a
 * known type, resolve against THAT type's members first AND drop the global
 * short-name fallback when the type lacks the member. Prevents `obj.clone()`
 * (obj: Worker) silently routing to `Error#clone`. Mirrors Java 9t8z / Go e6xx
 * "drop unsafe short-name fallback when receiver type known but member
 * missing". Tries the `#` (instance) form first, then `.` (associated
 * function), preferring the same-file candidate when the type name collides
 * across files (bd tea-rags-mcp-p8wz).
 *
 * Guard pass: a known receiver type whose member is absent DROPS the edge —
 * falling through to short-name lookup would resolve to a method on an
 * unrelated type (the c5by garbage). A receiver with no bound type continues
 * to the import-match / short-name passes.
 */
export class RustLocalBindingSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "localBinding";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const boundType = ctx.localBindings?.[call.receiver];
    if (!boundType) return CONTINUE;

    const instanceFq = `${boundType}#${call.member}`;
    const instanceHit = pickSameFileThenSingle(ctx.symbolTable.lookup(instanceFq), ctx.callerFile, this.cfg.mode);
    if (instanceHit) return resolved({ targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId });
    const staticFq = `${boundType}.${call.member}`;
    const staticHit = pickSameFileThenSingle(ctx.symbolTable.lookup(staticFq), ctx.callerFile, this.cfg.mode);
    if (staticHit) return resolved({ targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId });
    // Receiver type known but member not on it — DROP the edge.
    // Falling through to short-name lookup would resolve to a method
    // on an unrelated type, which is the c5by garbage.
    return DROP;
  }
}
