import type { CallContext, CallRef, DispatchEdge, SymbolResolutionTarget } from "../../contracts/types/codegraph.js";
import type { DispatchResolverComponent, SymbolResolutionStrategy } from "../../contracts/types/language.js";

/**
 * Drive an ordered chain of resolution strategies, returning the first
 * DECISIVE outcome. The order IS the resolution precedence — a strategy earlier
 * in the array wins over a later one for the same call. This is the
 * language-neutral engine a per-language `LanguageSymbolResolver` uses to run
 * its `SymbolResolutionStrategy[]`.
 *
 * Three-state semantics (the reason this engine exists rather than a bare
 * first-non-null loop):
 *
 *   - `resolved` — return the target immediately; the chain stops.
 *   - `drop`     — STOP the chain and return `null` (no edge). A guard pass
 *                  owns the call but it resolves to nothing — later passes must
 *                  NOT see it (bd tea-rags-mcp-4rgg: `super` without
 *                  `classExtends` must not fall through to same-file lookup).
 *   - `continue` — try the next strategy.
 *
 * Exhausting the chain without a decisive outcome returns `null`.
 */
export function resolveViaChain(
  strategies: readonly SymbolResolutionStrategy[],
  call: CallRef,
  ctx: CallContext,
): SymbolResolutionTarget | null {
  for (const strategy of strategies) {
    const outcome = strategy.attempt(call, ctx);
    if (outcome.kind === "resolved") return outcome.target;
    if (outcome.kind === "drop") return null;
    // continue → next strategy
  }
  return null;
}

/**
 * Drive an ordered list of dispatch components, returning the first NON-EMPTY
 * fan-out. The order IS the precedence (a component earlier in the array wins).
 * This is the fan-out mirror of `resolveViaChain`: "decisive" = non-empty here.
 * A per-language resolver composes its `DispatchResolverComponent[]` (e.g. Ruby:
 * registry-table → CHA-cone → dynamic-receiver) through this engine instead of
 * an inline if-ladder, so the precedence-compose is shared across languages.
 */
export function resolveDispatchViaComponents(
  components: readonly DispatchResolverComponent[],
  call: CallRef,
  ctx: CallContext,
): DispatchEdge[] {
  for (const component of components) {
    const edges = component.resolveDispatch(call, ctx);
    if (edges.length > 0) return edges;
  }
  return [];
}
