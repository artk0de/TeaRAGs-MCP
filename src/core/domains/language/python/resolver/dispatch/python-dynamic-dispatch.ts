import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import { DynamicDispatchResolver, EnclosingClassPrivateAccess } from "../../../kernel/index.js";
import { PythonImportFileMapper } from "../python-import-file-mapper.js";
import { lookupPythonSymbolsByShortName } from "../strategies/shared.js";
import type { PythonChainAnswerProbe } from "./python-chain-probe.js";
import { pythonDynamicFanoutSuppressed } from "./python-dispatch-gates.js";
import {
  PY_DYNAMIC_RECEIVER_CONFIDENCE,
  PYTHON_FANOUT_POPULATION,
  resolvePythonDispatchFanMax,
} from "./python-dispatch-policy.js";

/** An instance member — `Cls#member`. A module function (`fn`) and a
 *  class-level `Cls.member` are not what a VALUE receiver dispatches. */
const isPythonInstanceMember = (symbolId: string): boolean => symbolId.includes("#");

/**
 * Untyped-name short-name fan-out for Python (bd tea-rags-mcp-w205u, E4.1.3) —
 * Python's port set over the kernel `DynamicDispatchResolver` (K1, bd
 * tea-rags-mcp-m99j1.1.14).
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
 * The cascade takes neither the duck-vocabulary nor the literal-receiver
 * injection. Python has no duck vocabulary to hand it — the runtime-member
 * question is asked one gate earlier, by the external classifier, which also
 * knows whether the receiver is typed — and no literal-receiver map, because a
 * Python literal receiver (`"s".join`, `[].append`) never reaches here: it ends
 * in `"` or `]`, or its member is a core one. What is left is the signature
 * half — arity and kwargs, which Task E4.1.2 taught the Python walker to record
 * — plus the block narrower, inert on absent evidence, and the visibility
 * narrower under Python's own access rule. Python's `private` is a name-mangled
 * `__name` (bd tea-rags-mcp-jwjyr.1), reachable from inside a class of the
 * declaring class's name: the enclosing-class rule, NOT the explicit-receiver
 * default, which would drop `other.__x()` inside the class that declares it.
 */
export class PythonDynamicDispatchResolver extends DynamicDispatchResolver {
  constructor(
    probe: PythonChainAnswerProbe,
    coreAmbiguous: (call: CallRef, ctx: CallContext) => boolean,
    /** The resolver's ONE mapper — the foreign-head gate reads an import alias through it. */
    mapper: PythonImportFileMapper = new PythonImportFileMapper(),
    /** Read ONCE at composition — never a per-call `process.env` lookup. */
    fanMax: number = resolvePythonDispatchFanMax(process.env.CODEGRAPH_PY_DISPATCH_FAN_MAX),
  ) {
    super({
      suppressed: (call, ctx) => pythonDynamicFanoutSuppressed(call, ctx, probe, coreAmbiguous, mapper),
      lookupByShortName: (call, ctx) =>
        lookupPythonSymbolsByShortName(ctx, call.member, { role: "callee" }).filter((def) =>
          isPythonInstanceMember(def.symbolId),
        ),
      cascade: { visibilityAccess: new EnclosingClassPrivateAccess() },
      discount: PY_DYNAMIC_RECEIVER_CONFIDENCE,
      population: PYTHON_FANOUT_POPULATION,
      cap: fanMax,
    });
  }
}
