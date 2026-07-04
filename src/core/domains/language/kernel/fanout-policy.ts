import type { DispatchFanoutPolicy, GlobalSymbolTable } from "../../../contracts/types/codegraph.js";

/**
 * Floor for the corpus-adaptive dispatch fan-out cap (bd tea-rags-mcp-f2jsb).
 * A corpus whose defs-per-member p99 is below this still gets a workable cap:
 * legitimate small fan-outs (concern implementers, STI subtypes) stay well
 * under 16, while the pathological attribute-reader shape (`#firm` defined in
 * hundreds of multi-tenant models) sits orders of magnitude above it.
 */
export const DISPATCH_FANOUT_CAP_FLOOR = 16;

/**
 * Build the fan-out policy from a defs-per-shortName distribution. p99 uses the
 * same floor-index convention as `p95` in `contracts/signal-utils.ts`:
 * `sorted[min(floor(n * 0.99), n - 1)]`.
 */
export function buildDispatchFanoutPolicy(
  defCounts: Iterable<number>,
  opts?: { floor?: number },
): DispatchFanoutPolicy {
  const floor = opts?.floor ?? DISPATCH_FANOUT_CAP_FLOOR;
  const sorted = [...defCounts].sort((a, b) => a - b);
  const p99 = sorted.length === 0 ? 0 : sorted[Math.min(Math.floor(sorted.length * 0.99), sorted.length - 1)];
  return { cap: Math.max(floor, Math.ceil(p99)), p99DefsPerMember: p99 };
}

const policyCache = new WeakMap<GlobalSymbolTable, DispatchFanoutPolicy>();

/**
 * Policy for a symbol table, memoized per table instance. The p99 scan is O(m)
 * over distinct shortNames and runs ONCE per resolve pass — every dispatch
 * fan-out terminal (narrowing cascade, CHA cone) consults the same policy, so
 * language resolvers cannot bypass the cap.
 */
export function dispatchFanoutPolicyFor(table: GlobalSymbolTable, opts?: { floor?: number }): DispatchFanoutPolicy {
  const cached = policyCache.get(table);
  if (cached) return cached;
  const policy = buildDispatchFanoutPolicy(table.shortNameDefCounts().values(), opts);
  policyCache.set(table, policy);
  return policy;
}
