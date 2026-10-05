/**
 * K1 dynamic-receiver short-name fan-out (bd tea-rags-mcp-m99j1.1.14). A call
 * `recv.m` whose receiver carries no static type resolves `m` by short name
 * and emits the matches as discounted `dynamic` edges: low confidence beats
 * `null`. It is the last-resort dispatch component, so it must decline every
 * call something more precise answers — and WHICH calls those are is the
 * language's knowledge, not the kernel's.
 *
 * The language owns the ports:
 *   - `suppressed` — its gate runner, in its own measured order. A gate that
 *     asks whether the exact chain answers the call reads an
 *     {@link ExactChainAnswerProbe}.
 *   - `lookupByShortName` — the candidate population (file filter, lookup
 *     role, member-kind filter).
 *   - `cascade` — the language data the narrowing cascade injects.
 *   - `discount`, `population`, and an optional tighter `cap`.
 *
 * The kernel owns the order — gate, lookup, cascade, terminal — and the
 * terminal itself (`resolveNarrowedFanout`): one survivor is an edge at
 * confidence 1, more are `discount / n` each up to the cap, above it the
 * outcome is `ambiguous` with nothing emitted.
 */
import {
  emptyDispatchFanout,
  type CallContext,
  type CallRef,
  type DispatchFanoutOutcome,
  type SymbolDefinition,
} from "../../../contracts/types/codegraph.js";
import type {
  DispatchCascadeOptions,
  DispatchFanoutPopulation,
  DispatchResolverComponent,
} from "../../../contracts/types/language.js";
import { buildDispatchCascade } from "./dispatch-cascade.js";
import { resolveNarrowedFanout, type DispatchCandidateNarrower } from "./dispatch-narrowing.js";

/**
 * Does the language's exact resolver chain answer this call? A dynamic fan-out
 * REPLACES the chain's answer in the runner's dispatch-first path, so a gate
 * runner asks this before letting the fan-out fire.
 */
export interface ExactChainAnswerProbe {
  answers: (call: CallRef, ctx: CallContext) => boolean;
}

/**
 * Is the call's receiver a name the caller's def ASSIGNS (bd
 * tea-rags-mcp-m99j1.1.59)? The shared dynamic-fan gate predicate over
 * `CallContext.assignedLocals`: a local whose type no typed channel answered is
 * a value decided by an expression, and the project class that happens to spell
 * the member is a coincidence. Exact-name membership only — a dotted receiver
 * (`x.y`) is a different shape another gate owns. Each language publishes its
 * own set from its walker; whether to consult this is the language gate's call.
 */
export function receiverIsAssignedLocal(call: CallRef, ctx: CallContext): boolean {
  const { receiver } = call;
  return receiver !== null && ctx.assignedLocals?.includes(receiver) === true;
}

export interface DynamicDispatchPorts {
  /** The language gate runner, its gate order preserved. `true` → no fan-out. */
  suppressed: (call: CallRef, ctx: CallContext) => boolean;
  /** Candidates for `call.member` — the call, not the bare member, because a
   *  language may pick its lookup role from the call shape. */
  lookupByShortName: (call: CallRef, ctx: CallContext) => SymbolDefinition[];
  cascade: DispatchCascadeOptions;
  /** Confidence mass split over a multi-survivor fan. */
  discount: number;
  population: DispatchFanoutPopulation;
  /** A tighter ceiling than the policy cap; absent ⇒ the policy cap alone. */
  cap?: number;
}

export class DynamicDispatchResolver implements DispatchResolverComponent {
  private readonly narrowers: DispatchCandidateNarrower[];

  constructor(private readonly ports: DynamicDispatchPorts) {
    this.narrowers = buildDispatchCascade(ports.cascade);
  }

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
    if (this.ports.suppressed(call, ctx)) return emptyDispatchFanout();
    const candidates = this.ports.lookupByShortName(call, ctx);
    if (candidates.length === 0) return emptyDispatchFanout();
    return resolveNarrowedFanout(call, candidates, ctx, this.narrowers, this.ports.discount, {
      cap: this.ports.cap,
      edgeKind: "dynamic",
      population: this.ports.population,
    });
  }
}
