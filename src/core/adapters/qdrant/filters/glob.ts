/**
 * Glob pattern matching for Qdrant search results
 *
 * Provides client-side glob filtering since Qdrant doesn't support
 * glob patterns natively. Uses picomatch for full glob support.
 */

import picomatch from "picomatch";

/**
 * Creates a matcher function for a glob pattern
 *
 * @param pattern - Glob pattern (e.g., "**\/workflow/**", "src/**\/*.ts")
 * @returns Matcher function that tests if a path matches the pattern
 *
 * @example
 * const isMatch = createGlobMatcher("**\/workflow/**");
 * isMatch("models/workflow/task.ts"); // true
 * isMatch("src/utils/helper.ts"); // false
 */
export function createGlobMatcher(pattern: string): (path: string) => boolean {
  return picomatch(pattern, { bash: true });
}

/**
 * Result type with optional payload containing relativePath
 * Compatible with Qdrant SearchResult type
 */
export interface ResultWithPath {
  id?: string | number;
  score?: number;
  payload?: Record<string, unknown>;
}

/**
 * Filters search results by glob pattern on relativePath
 *
 * Used for post-filtering Qdrant results when glob patterns
 * are not supported natively by Qdrant filters.
 *
 * @param results - Array of search results with payload.relativePath
 * @param pattern - Glob pattern to match against relativePath
 * @returns Filtered results matching the pattern
 *
 * @example
 * const results = await qdrant.search(...);
 * const filtered = filterResultsByGlob(results, "**\/workflow/**");
 */
export function filterResultsByGlob<T extends ResultWithPath>(results: T[], pattern: string): T[] {
  const isMatch = createGlobMatcher(pattern);
  return results.filter((item) => {
    const path = item.payload?.relativePath;
    return typeof path === "string" && isMatch(path);
  });
}

/**
 * Calculates fetch limit for Qdrant queries.
 *
 * Always overfetches to ensure enough candidates for post-processing
 * (glob filtering, reranking). Uses higher multiplier when client-side
 * filtering or reranking will further reduce the result set.
 *
 * @param requestedLimit - The number of results the user wants
 * @param needsOverfetch - Whether extra overfetch is needed (pathPattern, rerank)
 * @returns The limit to use when querying Qdrant (minimum 20)
 */
export function calculateFetchLimit(requestedLimit: number, needsOverfetch: boolean): number {
  const multiplier = needsOverfetch ? 6 : 4;
  return Math.max(20, requestedLimit * multiplier);
}
