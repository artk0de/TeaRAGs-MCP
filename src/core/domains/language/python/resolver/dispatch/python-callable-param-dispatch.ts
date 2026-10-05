import type { CallContext, CallRef, DispatchFanoutOutcome } from "../../../../../contracts/types/codegraph.js";
import type { DispatchResolverComponent } from "../../../../../contracts/types/language.js";
import { resolveNarrowedFanout } from "../../../kernel/index.js";
import type { PythonCallableParamTargets } from "../python-callable-param-targets.js";

/**
 * The fan half of the P2 callable-value flow (bd tea-rags-mcp-m99j1.1.19):
 * several functions passed into an invoked parameter → one `cone` edge each,
 * at `1/N`, capped by the corpus-adaptive `dispatchFanoutPolicyFor` (an
 * over-cap set is an `ambiguous` verdict, not a fan). One target is the
 * chain's `callableParam` answer and fans nothing here.
 */
export class PythonCallableParamDispatchResolver implements DispatchResolverComponent {
  constructor(private readonly targets: PythonCallableParamTargets) {}

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
    const targets = this.targets.targetsOf(call, ctx);
    if (targets.length < 2) return { kind: "edges", edges: [] };
    return resolveNarrowedFanout(call, [...targets], ctx, [], 1, { edgeKind: "cone" });
  }
}
