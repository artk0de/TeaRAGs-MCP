import type { DispatchFanoutPolicy, GlobalSymbolTable, ResolveRunScope } from "../../../contracts/types/codegraph.js";
import type { DispatchFanoutPopulation } from "../../../contracts/types/language.js";
import { RunScopedMemo } from "./run-scoped-memo.js";

/**
 * Floor for the corpus-adaptive dispatch fan-out cap (bd tea-rags-mcp-f2jsb).
 * A corpus whose defs-per-member p99 is below this still gets a workable cap:
 * legitimate small fan-outs (concern implementers, STI subtypes) stay well
 * under 16, while the pathological attribute-reader shape (`#firm` defined in
 * hundreds of multi-tenant models) sits orders of magnitude above it.
 */
export const DISPATCH_FANOUT_CAP_FLOOR = 16;

/**
 * Fewest distinct short names a population must define before its OWN p99
 * replaces the corpus one (bd tea-rags-mcp-nbf8q).
 *
 * The floor-index p99 over n members excludes `n - 1 - floor(0.99 n)` of the
 * largest: none up to n = 100 (p99 IS the maximum, so one `#firm`-shaped
 * name would set the cap on its own), 9 at n = 1,000. Below this the population
 * is too small for a tail estimate and reads the corpus policy — the pre-nbf8q
 * behaviour, and the SAME answer for a single-language corpus. taxdome's Ruby
 * half defines ~29.7k names, its bash half 21.
 */
export const DISPATCH_FANOUT_POPULATION_MIN_MEMBERS = 1000;

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

const policyCache = new RunScopedMemo<GlobalSymbolTable, DispatchFanoutPolicy>();
const populationPolicyCache = new RunScopedMemo<GlobalSymbolTable, Map<string, DispatchFanoutPolicy>>();

/**
 * Policy for a symbol table, memoized per RUN (`opts.runScope`) and table. The
 * p99 scan is O(m) over distinct shortNames and runs ONCE per resolve pass —
 * every dispatch fan-out terminal (narrowing cascade, CHA cone) consults the
 * same policy, so language resolvers cannot bypass the cap.
 *
 * Per run, not per table instance (bd tea-rags-mcp-39xca.6): the pool keeps one
 * table per collection for its lifetime, so a table-keyed memo froze the cap at
 * the first run's distribution for as long as the process lived. A caller with
 * no run scope (harness, test) keeps the per-table lifetime.
 *
 * With `opts.population` the distribution is that population's own
 * defs-per-shortName (bd tea-rags-mcp-nbf8q): one polyglot table holds every
 * language, and a corpus p99 let a language with flat fan-outs hold down the
 * cap of one with a heavier legitimate tail (taxdome: corpus 16, Ruby 19). A
 * population under {@link DISPATCH_FANOUT_POPULATION_MIN_MEMBERS} names gets
 * the corpus policy object itself.
 */
export function dispatchFanoutPolicyFor(
  table: GlobalSymbolTable,
  opts?: { floor?: number; runScope?: ResolveRunScope; population?: DispatchFanoutPopulation },
): DispatchFanoutPolicy {
  if (opts?.population !== undefined) return populationPolicyFor(table, opts.population, opts);
  const cached = policyCache.get(opts?.runScope, table);
  if (cached) return cached;
  const policy = buildDispatchFanoutPolicy(table.shortNameDefCounts().values(), opts);
  policyCache.set(opts?.runScope, table, policy);
  return policy;
}

function populationPolicyFor(
  table: GlobalSymbolTable,
  population: DispatchFanoutPopulation,
  opts: { floor?: number; runScope?: ResolveRunScope },
): DispatchFanoutPolicy {
  let byFamily = populationPolicyCache.get(opts.runScope, table);
  const cached = byFamily?.get(population.family);
  if (cached) return cached;
  const counts = populationDefCounts(table, population);
  const policy =
    counts.length < DISPATCH_FANOUT_POPULATION_MIN_MEMBERS
      ? dispatchFanoutPolicyFor(table, { floor: opts.floor, runScope: opts.runScope })
      : buildDispatchFanoutPolicy(counts, opts);
  if (byFamily === undefined) {
    byFamily = new Map();
    populationPolicyCache.set(opts.runScope, table, byFamily);
  }
  byFamily.set(population.family, policy);
  return policy;
}

/**
 * Defs-per-shortName counted over `population`'s definitions only; a name the
 * population never defines is not one of its members. Reads through the
 * DEFAULT `lookupByShortName`, the same view `shortNameDefCounts` counts —
 * schema-synthesized columns stay out, as they do from the corpus scan.
 */
function populationDefCounts(table: GlobalSymbolTable, population: DispatchFanoutPopulation): number[] {
  const counts: number[] = [];
  for (const name of table.shortNameDefCounts().keys()) {
    let n = 0;
    for (const def of table.lookupByShortName(name)) if (population.ownsPath(def.relPath)) n++;
    if (n > 0) counts.push(n);
  }
  return counts;
}
