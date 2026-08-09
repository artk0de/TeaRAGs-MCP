/**
 * bd tea-rags-mcp-a466 — overload disambiguation.
 *
 * Multiple `method_declaration` nodes with the same name compose to identical
 * symbolIds (three `upperCase(...)` overloads under `class StringUtils` all
 * compose as `StringUtils.upperCase`). One disambiguator instance counts
 * occurrences per composed symbolId WITHIN a single child-emission pass and
 * suffixes every occurrence after the first with `~N` (1-based; the first stays
 * unchanged). The same convention runs on the codegraph provider's
 * `collectSymbols`, so cg_symbols and the Qdrant payload agree on the same
 * physical AST node. See `.claude/rules/symbolid-convention.md`.
 *
 * Opt-in per language (`disambiguateOverloads`): default-off keeps TS get/set
 * pairs and Python `@functools.singledispatch` stub/impl pairs on their
 * first-occurrence behaviour.
 */
export class SymbolIdDisambiguator {
  private readonly occurrences = new Map<string, number>();

  constructor(private readonly enabled: boolean) {}

  /**
   * Register one occurrence of `baseId` and return the id this occurrence
   * should carry. Pass-through (no counting) when the language opted out.
   */
  disambiguate(baseId: string | undefined): string | undefined {
    if (baseId === undefined) return undefined;
    if (!this.enabled) return baseId;
    const seen = this.occurrences.get(baseId) ?? 0;
    const next = seen + 1;
    this.occurrences.set(baseId, next);
    return next === 1 ? baseId : `${baseId}~${next}`;
  }
}
