import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { ResolverConfig } from "./shared.js";

/**
 * `super().X()` / `super.X()` — walk to the PARENT class via `classExtends`,
 * then resolve `<Parent>#<member>` (bd tea-rags-mcp-pic4). This is the one
 * **guard** strategy: when the receiver is `super` it is always terminal — it
 * either resolves or **drops**, never continues. Without a resolvable parent
 * the call would fall through to short-name fallback, which is ambiguous when
 * multiple classes share the same `__init__` / `method` short-name and emits a
 * wrong edge (same family as the TS `super` bug tea-rags-mcp-4rgg). Mirrors the
 * TS resolver's `resolveSuper` walk with single-inheritance Python semantics.
 */
export class PythonSuperSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "super";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "super()" && call.receiver !== "super") return CONTINUE;
    const target = this.resolveSuper(call.member, ctx);
    // `super` is terminal: a miss is a DROP, not a fall-through (bd pic4/4rgg).
    return target ? resolved(target) : DROP;
  }

  /**
   * Resolve a `super().X()` call against the parent class determined by
   * `ctx.classExtends`. Walks the single-inheritance chain (B extends A,
   * A extends C, …) until an ancestor's file owns a symbol matching
   * `member`. Returns:
   *
   *   - `{ relPath, symbolId }` when an ancestor in the chain has the
   *     method — instance form preferred, static fallback.
   *   - `null` when the enclosing class is unknown, the parent chain is
   *     empty, or no ancestor in the project defines `member`.
   *
   * Mirrors `TSSuperSymbolResolutionStrategy.resolveSuper` (bd
   * tea-rags-mcp-4rgg) with single-inheritance Python semantics.
   */
  private resolveSuper(member: string, ctx: CallContext): SymbolResolutionTarget | null {
    if (ctx.callerScope.length === 0) return null;
    if (!ctx.classExtends) return null;
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    let current: string | undefined = ctx.classExtends[enclosing];
    if (!current) return null;
    const visited = new Set<string>([enclosing]);
    while (current && !visited.has(current)) {
      visited.add(current);
      // Instance form first — `super().__init__()` is an instance-method
      // dispatch by definition. Static fallback covers the unusual
      // `super().classmethod()` shape (legal Python but rare).
      const instanceFq = `${current}#${member}`;
      const instanceHit = ctx.symbolTable.lookup(instanceFq);
      const instanceTarget = pickSingleCandidate(instanceHit, this.cfg.mode);
      if (instanceTarget) {
        return { targetRelPath: instanceTarget.relPath, targetSymbolId: instanceTarget.symbolId };
      }
      const staticFq = `${current}.${member}`;
      const staticHit = ctx.symbolTable.lookup(staticFq);
      const staticTarget = pickSingleCandidate(staticHit, this.cfg.mode);
      if (staticTarget) {
        return { targetRelPath: staticTarget.relPath, targetSymbolId: staticTarget.symbolId };
      }
      // Walk one step deeper.
      current = ctx.classExtends[current];
    }
    return null;
  }
}
