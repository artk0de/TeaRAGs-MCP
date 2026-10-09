/**
 * Path-membership filters on the keyword-indexed `relativePathExact` (bd
 * tea-rags-mcp-ejio7) — the twin of the text-indexed `relativePath` that
 * `contracts/relative-path-exact.ts` defines.
 *
 * A keyword index serves `match: { any }` from its posting lists, so one
 * condition answers a whole path set at index price — the shape
 * `./text-indexed-exact.ts` cannot offer on `relativePath`, whose workarounds
 * are a `should` of text+value pairs (~6 ms per branch at 200 wide on a
 * 153k-point collection) or one scroll per path (~1.57 ms per path).
 *
 * Only for a collection the membership gate serves
 * (`../relative-path-exact-capability.ts`): on one that has not finished the
 * v20 backfill, points without the key escape a keyword filter silently.
 */

import { RELATIVE_PATH_EXACT_KEY } from "../../../contracts/relative-path-exact.js";

/**
 * Paths named by one MatchAny. Not a correctness bound — the keyword index
 * answers any size — but a request-size one: the set is the deleted or touched
 * files of a run, which reaches thousands, and one filter per few hundred keeps
 * each request body in the tens of kilobytes and each scroll's result bounded.
 */
export const RELATIVE_PATHS_PER_KEYWORD_FILTER = 256;

/** One `relativePathExact` MatchAny, to be placed in a `must`. */
export type RelativePathExactAnyOf = { key: typeof RELATIVE_PATH_EXACT_KEY; match: { any: string[] } };

/**
 * The filter admitting exactly the points of `paths`.
 *
 * An EMPTY set throws, for the reason `anyOfOnTextIndexed` does: a caller that
 * asks for membership in nothing has a bug, and the filter may be handed to a
 * delete. Plain `Error` — a caller bug, `.claude/rules/typed-errors.md` rule 5.
 */
export function relativePathExactFilter(paths: readonly string[]): { must: [RelativePathExactAnyOf] } {
  if (paths.length === 0) {
    throw new Error(
      "relativePathExactFilter([]): membership in an empty path set is a caller bug — return early instead.",
    );
  }
  return { must: [{ key: RELATIVE_PATH_EXACT_KEY, match: { any: [...paths] } }] };
}

/**
 * The path set as filter-sized groups: distinct paths, in first-seen order,
 * partitioned with no empty group — an empty input yields no group, so no
 * request.
 */
export function relativePathExactGroups(paths: Iterable<string>): string[][] {
  const distinct = [...new Set(paths)];
  const groups: string[][] = [];
  for (let start = 0; start < distinct.length; start += RELATIVE_PATHS_PER_KEYWORD_FILTER) {
    groups.push(distinct.slice(start, start + RELATIVE_PATHS_PER_KEYWORD_FILTER));
  }
  return groups;
}
