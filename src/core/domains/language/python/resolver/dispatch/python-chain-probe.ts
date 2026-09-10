import type { CallContext, CallRef, SymbolResolutionTarget } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { resolveViaChain } from "../../../resolver-chain.js";

/**
 * The chain's answer for a call, computed at most once per call site (bd
 * tea-rags-mcp-w205u, E4.1.3).
 *
 * The runner asks `resolveDispatch` BEFORE `resolve` and lets a non-empty
 * fan-out replace the chain's answer (`resolution-runner.ts:557`), so a
 * last-resort component must know whether the chain would have answered. Ruby
 * asks two named passes (`exactPassAnswersReceiver`); Python cannot, because a
 * bare name is answered by `namingConvention`, `importedName` OR
 * `globalShortName` and its terminal guards DROP rather than continue. The
 * honest predicate is the chain's own outcome, so it is computed here and
 * MEMOISED — `PythonCallResolver.resolve` reads the same entry, and the
 * runner's dispatch→resolve pair costs one chain run per site rather than two.
 *
 * Keyed by `CallRef` IDENTITY with the `CallContext` identity carried beside
 * it: the same `CallRef` object is never re-walked under a different context
 * within a run, and checking it makes a harness that does so correct anyway. A
 * `WeakMap` because the walk holds every `CallRef` only as long as its chunk.
 */
export class PythonChainAnswerProbe {
  private readonly memo = new WeakMap<CallRef, { ctx: CallContext; target: SymbolResolutionTarget | null }>();

  constructor(private readonly chain: readonly SymbolResolutionStrategy[]) {}

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    const hit = this.memo.get(call);
    if (hit?.ctx === ctx) return hit.target;
    const target = resolveViaChain(this.chain, call, ctx);
    this.memo.set(call, { ctx, target });
    return target;
  }

  answers(call: CallRef, ctx: CallContext): boolean {
    return this.resolve(call, ctx) !== null;
  }
}
