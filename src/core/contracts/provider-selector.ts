/**
 * Selector matching for enrichment provider keys.
 *
 * Provider keys are a dotted namespace (`git`, `codegraph.symbols`), so a
 * selector naming the namespace has to reach every provider under it —
 * `codegraph` must select `codegraph.symbols` today and `codegraph.complexity`
 * tomorrow without the caller re-listing them.
 *
 * Pure string work over an explicit provider list: contracts owns it so both
 * the ingest domain (which resolves selectors to providers) and the CLI (which
 * validates what the user typed) read the same definition instead of each
 * growing a slightly different prefix check.
 */

/** Selector that expands to every registered provider. */
export const ALL_PROVIDERS_SELECTOR = "all";

/**
 * Does `providerKey` fall under `selector`?
 *
 * Exact match, or the selector names an ancestor namespace. The dot is
 * load-bearing: a bare string prefix would let `codegraph` swallow an
 * unrelated `codegraphx`.
 */
export function matchesProviderSelector(providerKey: string, selector: string): boolean {
  return providerKey === selector || providerKey.startsWith(`${selector}.`);
}

/** Providers picked by a selector list, plus the selectors that hit nothing. */
export interface ProviderSelection {
  matched: string[];
  unknown: string[];
}

/**
 * Resolve selectors against the registered provider keys.
 *
 * Results keep `available` order and are de-duplicated, so overlapping
 * selectors (`codegraph` plus `codegraph.symbols`) resolve to one stable set.
 * A selector matching nothing is reported rather than dropped — recomputing a
 * smaller subset than intended is indistinguishable from success once the run
 * finishes, so the caller has to be able to refuse.
 */
export function selectProviderKeys(available: readonly string[], selectors: readonly string[]): ProviderSelection {
  if (selectors.includes(ALL_PROVIDERS_SELECTOR)) {
    return { matched: [...available], unknown: [] };
  }

  const matched = new Set<string>();
  const unknown: string[] = [];
  for (const selector of selectors) {
    const hits = available.filter((key) => matchesProviderSelector(key, selector));
    if (hits.length === 0) {
      unknown.push(selector);
      continue;
    }
    for (const hit of hits) matched.add(hit);
  }

  return { matched: available.filter((key) => matched.has(key)), unknown };
}
