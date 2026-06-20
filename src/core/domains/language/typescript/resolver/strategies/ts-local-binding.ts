import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  resolveLocalBindingType,
  type CallContext,
  type CallRef,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Typed-parameter receiver — `param.method()` where `param` is a function /
 * method / arrow parameter the walker bound to a type in `ctx.localBindings`
 * (bd tea-rags-mcp-x6ta). Resolve `<Type>#member` (instance) then
 * `<Type>.member` (static) against the global symbol table. Ordered BEFORE the
 * import-receiver passes so an unambiguous local type wins over the ambiguous
 * short-name fallback that drops interface-typed calls when the caller imports
 * every implementer. On miss, continue — never fabricate an edge (mirrors the
 * Go / Python `resolveByLocalType` contract).
 */
export class TSLocalBindingSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "localBinding";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const boundType = resolveLocalBindingType(ctx.localBindings, call.receiver, call.startLine);
    if (!boundType) return CONTINUE;
    const localHit = this.resolveByLocalType(boundType, call.member, ctx);
    return localHit ? resolved(localHit) : CONTINUE;
  }

  /**
   * Tries `typeName#member` (instance form) first, then `typeName.member`
   * (static form). Returns `null` on miss — the caller then continues to the
   * import-receiver / short-name passes rather than fabricating an edge.
   *
   * When `typeName` is an interface with multiple implementations and no single
   * indexed `typeName#member` definition (interfaces declare no method bodies
   * that become symbols), `lookup` returns no candidate and this returns
   * `null`, deferring to the import-narrowed fallback (bd tea-rags-mcp-2qp6)
   * which biases toward the concrete implementer the caller imports.
   */
  private resolveByLocalType(typeName: string, member: string, ctx: CallContext): SymbolResolutionTarget | null {
    const instanceCandidates = ctx.symbolTable.lookup(`${typeName}#${member}`);
    const instanceHit = pickSingleCandidate(instanceCandidates, this.cfg.mode);
    if (instanceHit) return { targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId };
    const staticCandidates = ctx.symbolTable.lookup(`${typeName}.${member}`);
    const staticHit = pickSingleCandidate(staticCandidates, this.cfg.mode);
    if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
    return null;
  }
}
