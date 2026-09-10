import {
  emptyDispatchFanout,
  type CallContext,
  type CallRef,
  type DispatchFanoutOutcome,
} from "../../../../../contracts/types/codegraph.js";
import type { DispatchResolverComponent } from "../../../../../contracts/types/language.js";
import { buildDispatchCascade } from "../../../kernel/dispatch-cascade.js";
import { resolveNarrowedFanout } from "../../../kernel/dispatch-narrowing.js";
import { lookupPythonSymbolsByShortName } from "../strategies/shared.js";
import type { PythonChainAnswerProbe } from "./python-chain-probe.js";
import { pythonDynamicFanoutSuppressed } from "./python-dispatch-gates.js";
import { PY_DYNAMIC_RECEIVER_CONFIDENCE, resolvePythonDispatchFanMax } from "./python-dispatch-policy.js";

/** An instance member — `Cls#member`. A module function (`fn`) and a
 *  class-level `Cls.member` are not what a VALUE receiver dispatches. */
const isPythonInstanceMember = (symbolId: string): boolean => symbolId.includes("#");

/**
 * Untyped-name short-name fan-out for Python (bd tea-rags-mcp-w205u, E4.1.3).
 *
 * `service.execute()` where nothing typed `service`: no annotation, no
 * constructor call, no import — 373 of the 423 rows E4.0.4 attributed to
 * `untypedNameReceiver`, 330 of them polar. The exact chain declines them all
 * (its typed passes have nothing to read and `globalShortName` is gated), so
 * they are misses today. This component resolves `member` by short name over
 * the project's own Python classes, narrows the candidates through the kernel
 * cascade, and lets the terminal decide: one survivor is an EDGE at confidence
 * 1, two to `PY_DISPATCH_FAN_MAX` are a discounted fan, more than that is
 * `ambiguous` with nothing emitted.
 *
 * It is the LAST component and it declines every receiver anything else can
 * answer — see {@link pythonDynamicFanoutSuppressed}, whose final gate runs the
 * chain itself. That ordering is what keeps the runner's dispatch-first path
 * honest: a fan REPLACES a chain answer, so a component that fired where the
 * chain answers would bury an exact edge under N discounted ones.
 *
 * The cascade is built with NEITHER language injection. Python has no duck
 * vocabulary to hand it — the runtime-member question is asked one gate
 * earlier, by the external classifier, which also knows whether the receiver is
 * typed — and no literal-receiver map, because a Python literal receiver
 * (`"s".join`, `[].append`) never reaches here: it ends in `"` or `]`, or its
 * member is a core one. What is left is the signature half — arity and kwargs,
 * which Task E4.1.2 taught the Python walker to record — plus two narrowers
 * that keep every candidate on absent evidence.
 */
export class PythonDynamicDispatchResolver implements DispatchResolverComponent {
  private readonly narrowers = buildDispatchCascade();

  constructor(
    private readonly probe: PythonChainAnswerProbe,
    private readonly coreAmbiguous: (call: CallRef, ctx: CallContext) => boolean,
    /** Read ONCE at composition — never a per-call `process.env` lookup. */
    private readonly fanMax: number = resolvePythonDispatchFanMax(process.env.CODEGRAPH_PY_DISPATCH_FAN_MAX),
  ) {}

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
    if (pythonDynamicFanoutSuppressed(call, ctx, this.probe, this.coreAmbiguous)) return emptyDispatchFanout();
    const candidates = lookupPythonSymbolsByShortName(ctx, call.member).filter((def) =>
      isPythonInstanceMember(def.symbolId),
    );
    if (candidates.length === 0) return emptyDispatchFanout();
    return resolveNarrowedFanout(call, candidates, ctx, this.narrowers, PY_DYNAMIC_RECEIVER_CONFIDENCE, {
      cap: this.fanMax,
      edgeKind: "dynamic",
    });
  }
}
