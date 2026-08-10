import type {
  CallContext,
  CallRef,
  DispatchFanoutOutcome,
  SymbolResolutionTarget,
} from "../../contracts/types/codegraph.js";
import type { DispatchResolverComponent, SymbolResolutionStrategy } from "../../contracts/types/language.js";

/**
 * Drive an ordered chain of resolution strategies, returning the first
 * DECISIVE outcome. The order IS the resolution precedence — a strategy earlier
 * in the array wins over a later one for the same call. This is the
 * language-neutral engine a per-language `LanguageSymbolResolver` uses to run
 * its `SymbolResolutionStrategy[]`.
 *
 * Four-state semantics (the reason this engine exists rather than a bare
 * first-non-null loop):
 *
 *   - `resolved` — return the target immediately; the chain stops.
 *   - `deferred` — PARK the target and keep going. A pass with a weak answer
 *                  (target file known, member not pinned) offers it rather than
 *                  committing, so later passes still get their chance
 *                  (bd tea-rags-mcp-5onmn).
 *   - `drop`     — STOP the chain, emitting whatever is parked. A guard pass
 *                  owns the call but it resolves to nothing — later passes must
 *                  NOT see it (bd tea-rags-mcp-4rgg: `super` without
 *                  `classExtends` must not fall through to same-file lookup).
 *   - `continue` — try the next strategy.
 *
 * Exhausting the chain emits the parked proposal, or `null` when there is none.
 *
 * Parking obeys the same precedence as everything else here:
 *
 *   - a `resolved` from ANY position beats a park — a pinned symbol always
 *     outranks a module-level guess;
 *   - the FIRST park wins, because chain order is precedence and a pass that
 *     defers waives it only in favour of a stronger POSITIVE answer;
 *   - `drop` bars every LATER pass from answering, but does not retroactively
 *     veto an EARLIER pass's offer. That distinction is what makes deferral
 *     edge-preserving by construction: where a pass used to commit a file-only
 *     edge and a downstream guard therefore never ran, the same edge now comes
 *     out of the park. Ruby is the case that forces it — `receiverSetDrop` sits
 *     at chain position 13 and drops every remaining receiver-set call, so a
 *     drop that cleared the park would shed Ruby's parked edges wholesale.
 *
 * A guard that positively knows NO edge should exist would need to veto a park
 * rather than merely drop. No such guard exists today (TypeScript's external
 * checks return `continue`, not `drop`), so that state is not modelled.
 */
export function resolveViaChain(
  strategies: readonly SymbolResolutionStrategy[],
  call: CallRef,
  ctx: CallContext,
): SymbolResolutionTarget | null {
  let parked: SymbolResolutionTarget | null = null;
  for (const strategy of strategies) {
    const outcome = strategy.attempt(call, ctx);
    if (outcome.kind === "resolved") return outcome.target;
    if (outcome.kind === "drop") return parked;
    if (outcome.kind === "deferred") parked ??= outcome.target;
    // continue → next strategy
  }
  return parked;
}

/**
 * Drive an ordered list of dispatch components, returning the first DECISIVE
 * outcome — a non-empty fan-out or an over-cap `ambiguous` verdict. The order
 * IS the precedence (a component earlier in the array wins). This is the
 * fan-out mirror of `resolveViaChain`.
 * A per-language resolver composes its `DispatchResolverComponent[]` (e.g. Ruby:
 * registry-table → CHA-cone → dynamic-receiver) through this engine instead of
 * an inline if-ladder, so the precedence-compose is shared across languages.
 */
export function resolveDispatchViaComponents(
  components: readonly DispatchResolverComponent[],
  call: CallRef,
  ctx: CallContext,
): DispatchFanoutOutcome {
  for (const component of components) {
    const outcome = component.resolveDispatch(call, ctx);
    // Decisive: a non-empty fan-out OR an over-cap ambiguous verdict (bd
    // f2jsb) — a later component must not re-fan a call an earlier one already
    // judged too ambiguous to carry information.
    if (outcome.kind === "ambiguous" || outcome.edges.length > 0) return outcome;
  }
  return { kind: "edges", edges: [] };
}
