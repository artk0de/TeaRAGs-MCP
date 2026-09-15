/**
 * Exact `pathPattern` enforcement for the explore strategies (bd tea-rags-mcp-xf01b).
 *
 * `pathPattern` reaches Qdrant only as the pre-filter `globToTextFilter` builds: a
 * token match on the text-indexed `relativePath` that strips wildcards and a
 * trailing filename remnant, so `**\/pipeline/enrichment/completion-runner.ts`
 * asks for `pipeline/enrichment/` — every file of that directory. The lowering
 * stays: it is a correct SUPERSET and it uses the index. This module narrows that
 * superset to what the glob names, with the matcher every pathPattern-taking tool
 * shares (`infra/path-pattern.ts`).
 *
 * Narrowing thins a page, so a strategy fetches again with a doubled limit until
 * the page is filled, the source is exhausted, or `PATH_PATTERN_MAX_FETCHES`
 * requests have gone out. No pathPattern → exactly one fetch, results untouched.
 */

import { compilePathPatternMatcher, type PathPatternMatcher } from "../../../infra/path-pattern.js";
import type { ExploreResult } from "./types.js";

/**
 * Upper bound on the requests one exact-pathPattern page may send. The fetch
 * limit doubles per request, so the last asks for 8× the strategy's own first
 * fetch — which is already the ×2 / ×4 rerank pool from
 * `BaseExploreStrategy#applyDefaults`, times 3 at hybrid/similar file level.
 */
export const PATH_PATTERN_MAX_FETCHES = 4;

/** What a limit counts: chunk hits, or distinct files. */
export type PathPatternCountUnit = "chunk" | "file";

export interface PathPatternFetchPlan {
  /** Limit of the first request, counted in `fetchUnit`. */
  fetchLimit: number;
  /** What the source's limit counts — a source returning fewer is exhausted. */
  fetchUnit: PathPatternCountUnit;
  /** Exact matches that fill the page, counted in `targetUnit`. */
  target: number;
  targetUnit: PathPatternCountUnit;
}

/** One request's exact matches, and whether the source had nothing past them. */
export interface PathPatternPage {
  matches: ExploreResult[];
  exhausted: boolean;
}

/** Keep the results whose `payload.relativePath` the matcher selects. */
export function keepPathPatternMatches<R extends { payload?: Record<string, unknown> }>(
  results: R[],
  matcher: PathPatternMatcher,
): R[] {
  return results.filter((result) => {
    const relativePath = result.payload?.relativePath;
    return typeof relativePath === "string" && matcher(relativePath);
  });
}

function countUnits(results: readonly ExploreResult[], unit: PathPatternCountUnit): number {
  if (unit === "chunk") return results.length;
  return new Set(results.map((result) => result.payload?.relativePath)).size;
}

/**
 * The bounded fill loop: fetch, and while the page is neither filled nor the
 * source exhausted, fetch again at twice the limit — at most
 * `PATH_PATTERN_MAX_FETCHES` requests. Each request REPLACES the previous page:
 * a ranked source asked for more returns a longer prefix of the same order.
 */
export async function fetchUntilPathPatternFilled(
  initialFetchLimit: number,
  fetchPage: (fetchLimit: number) => Promise<PathPatternPage>,
  isFilled: (matches: ExploreResult[]) => boolean,
): Promise<ExploreResult[]> {
  let fetchLimit = initialFetchLimit;
  let page = await fetchPage(fetchLimit);
  for (let fetches = 1; fetches < PATH_PATTERN_MAX_FETCHES && !page.exhausted && !isFilled(page.matches); fetches++) {
    fetchLimit *= 2;
    page = await fetchPage(fetchLimit);
  }
  return page.matches;
}

/**
 * Fetch through `fetch` and enforce `pathPattern` exactly on what comes back,
 * filling the page per `plan`. Without a pattern this is `fetch(plan.fetchLimit)`
 * — one request, the same one the strategy always sent.
 */
export async function fetchPathPatternMatches(
  pathPattern: string | undefined,
  plan: PathPatternFetchPlan,
  fetch: (fetchLimit: number) => Promise<ExploreResult[]>,
): Promise<ExploreResult[]> {
  const matcher = compilePathPatternMatcher(pathPattern);
  if (!matcher) return fetch(plan.fetchLimit);
  return fetchUntilPathPatternFilled(
    plan.fetchLimit,
    async (fetchLimit) => {
      const raw = await fetch(fetchLimit);
      return {
        matches: keepPathPatternMatches(raw, matcher),
        exhausted: countUnits(raw, plan.fetchUnit) < fetchLimit,
      };
    },
    (matches) => countUnits(matches, plan.targetUnit) >= plan.target,
  );
}
