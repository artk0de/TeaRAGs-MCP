import type { CallContext, CallRef, SymbolResolutionTarget } from "../../contracts/types/codegraph.js";
import type { SymbolResolutionStrategy } from "../../contracts/types/language.js";

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
