import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { PythonCallableParamTargets } from "../python-callable-param-targets.js";

/**
 * `view_func(...)` where `view_func` is a parameter of an enclosing
 * module-level def (P2 callable-value flow, bd tea-rags-mcp-m99j1.1.19): the
 * chain half. Exactly one function passed into the parameter anywhere in the
 * run → that function, an `exact` answer; several are
 * `PythonCallableParamDispatchResolver`'s `cone` fan, and none CONTINUEs.
 */
export class PythonCallableParamSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "callableParam";

  constructor(private readonly targets: PythonCallableParamTargets) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const targets = this.targets.targetsOf(call, ctx);
    return targets.length === 1
      ? resolved({ targetRelPath: targets[0].relPath, targetSymbolId: targets[0].symbolId })
      : CONTINUE;
  }
}
