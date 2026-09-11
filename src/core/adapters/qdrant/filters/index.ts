/**
 * Qdrant filters module
 *
 * Provides glob-based pre-filtering, exact matching on text-indexed keys, and
 * filter merge utilities.
 */

export { globToTextFilter } from "./glob.js";
export { symbolIdLastSegment, symbolIdTextToken, SYMBOL_SEPARATORS } from "./symbolid-text-token.js";
export { anyOfOnTextIndexed, exactMatchOnTextIndexed, TEXT_INDEXED_KEYS } from "./text-indexed-exact.js";
export type { TextIndexedAnyOf, TextIndexedExactMatch, TextIndexedKey } from "./text-indexed-exact.js";
export { mergeQdrantFilters } from "./utils.js";
