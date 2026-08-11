/**
 * Selector matching for the `--languages` filter.
 *
 * Sibling of `provider-selector.ts` and deliberately NOT the same matcher: a
 * provider key is a dotted namespace where `codegraph` must reach
 * `codegraph.symbols`, while a language name is flat. Prefix matching here
 * would let `type` silently select `typescript`, so the match is exact.
 *
 * Lives in contracts because both the ingest domain (which turns the selection
 * into a Qdrant filter) and the API layer (which validates what the operator
 * typed) need one definition rather than two drifting copies. Translating a
 * language to file extensions is NOT here — that needs `LANGUAGE_MAP`, which
 * belongs to the chunker, and contracts may not import a domain.
 */

/** Languages picked from the indexed set, plus the ones that matched nothing. */
export interface LanguageSelection {
  matched: string[];
  unknown: string[];
}

/**
 * Canonical form of a language name as typed on the command line.
 *
 * Payload stores lowercase (`typescript`), but prose and tab-completion produce
 * `TypeScript`, and a comma-separated list leaves space around entries.
 */
export function normalizeLanguageSelector(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Resolve requested languages against the ones actually present in the index.
 *
 * Matched entries keep `indexed` order and are de-duplicated, so the resulting
 * filter is stable no matter how the flag was written. A request matching
 * nothing is reported rather than dropped: a filter selecting zero points still
 * completes successfully, which would read as "recomputed" to the operator.
 *
 * Validating against the INDEXED languages rather than the ones the build can
 * parse is deliberate — a language the parser supports but the corpus does not
 * contain is exactly the typo case worth catching.
 */
export function selectLanguages(indexed: readonly string[], requested: readonly string[]): LanguageSelection {
  const available = new Set(indexed.map(normalizeLanguageSelector));

  const matched = new Set<string>();
  const unknown: string[] = [];
  for (const raw of requested) {
    const language = normalizeLanguageSelector(raw);
    if (available.has(language)) matched.add(language);
    else unknown.push(language);
  }

  return { matched: indexed.filter((language) => matched.has(normalizeLanguageSelector(language))), unknown };
}
