/**
 * Why a hybrid_search / semantic_search answer came back empty (agent turn
 * economy N6, bd tea-rags-mcp-wrosj). An empty list conflates "the corpus has
 * nothing", "the pathPattern names nothing" and "a filter removed it" — and an
 * agent that cannot tell them apart re-checks every empty answer with grep.
 *
 * Diagnosed in a fixed order, each step a count over the INDEX, run only after
 * the search answered empty (the caller guarantees that):
 *
 * 1. `pathPattern` alone matches no point → `pathPatternMatchesNothing`. The
 *    Qdrant pre-filter `pathPattern` lowers to is a token SUPERSET of the glob
 *    (`strategies/path-pattern-fill.ts`), so a non-zero count is confirmed
 *    against a bounded sample with the exact matcher; a sample that did not
 *    exhaust the superset never claims "nothing".
 * 2. points exist without the caller's filters / the preset default →
 *    `filteredOut`, naming what to drop.
 * 3. otherwise → `noMatch`.
 */

import type { EmptyAnswerExplanation } from "../../../contracts/types/empty-answer.js";
import { compilePathPatternMatcher, pathPatternLiteralPrefix } from "../../../primitives/paths/index.js";
import type { PresetFilterNotice } from "../../public/dto/explore.js";

/** Index reads the diagnosis takes — bound to the searched collection by the caller. */
export interface EmptySearchCounter {
  /** Points matching `filter`; `undefined` = the whole collection. */
  count: (filter: Record<string, unknown> | undefined) => Promise<number>;
  /** At most `limit` `relativePath`s of points matching `filter`. */
  samplePaths: (filter: Record<string, unknown>, limit: number) => Promise<string[]>;
}

/** What narrowed the empty search. */
export interface EmptySearchScope {
  pathPattern?: string;
  /** The Qdrant pre-filter a `pathPattern` lowers to; `undefined` when it constrains nothing. */
  pathFilter: (pathPattern: string) => Record<string, unknown> | undefined;
  /** Request params besides `pathPattern` that narrowed the set (`filter`, `language`, …). */
  narrowingParams: readonly string[];
  /** Present when a rerank preset's DEFAULT filter narrowed the set. */
  presetFilterNotice?: PresetFilterNotice;
}

/** Points sampled to confirm a superset count against the exact glob. */
const PATH_SAMPLE_LIMIT = 256;
const MAX_SUGGESTIONS = 5;
const CLEAR_FILTER = "filter: {}";

export async function explainEmptySearch(
  counter: EmptySearchCounter,
  scope: EmptySearchScope,
): Promise<EmptyAnswerExplanation> {
  const { pathPattern } = scope;
  const pathFilter = pathPattern ? scope.pathFilter(pathPattern) : undefined;
  if (pathPattern && !(await pathPatternMatchesAny(counter, pathPattern, pathFilter))) {
    const nearest = await nearestExistingPrefix(counter, scope, pathPattern);
    const hint = nearest ? ` Nearest existing prefix: ${nearest}.` : "";
    return {
      reason: "pathPatternMatchesNothing",
      message: `pathPattern "${pathPattern}" matches no indexed file.${hint}`,
      ...(nearest ? { suggestions: [nearest] } : {}),
    };
  }
  const drops = filtersToDrop(scope);
  if (drops.length > 0 && (await counter.count(pathFilter)) > 0) {
    return { reason: "filteredOut", message: filteredOutMessage(scope, drops), suggestions: drops };
  }
  return {
    reason: "noMatch",
    message: pathPattern
      ? `Nothing in pathPattern "${pathPattern}" matched the query.`
      : "Nothing in the index matched the query.",
  };
}

async function pathPatternMatchesAny(
  counter: EmptySearchCounter,
  pathPattern: string,
  pathFilter: Record<string, unknown> | undefined,
): Promise<boolean> {
  if (pathFilter === undefined) return true;
  if ((await counter.count(pathFilter)) === 0) return false;
  const matches = compilePathPatternMatcher(pathPattern);
  if (!matches) return true;
  const sample = await counter.samplePaths(pathFilter, PATH_SAMPLE_LIMIT);
  return sample.some(matches) || sample.length >= PATH_SAMPLE_LIMIT;
}

/** Longest literal directory prefix of `pathPattern` that holds indexed points, as a `<dir>/**` glob. */
async function nearestExistingPrefix(
  counter: EmptySearchCounter,
  scope: EmptySearchScope,
  pathPattern: string,
): Promise<string | undefined> {
  const literal = pathPatternLiteralPrefix(pathPattern.replace(/^!/, ""));
  const segments = literal.split("/").filter((s) => s !== "");
  // A literal not ending in "/" ends in a partial name, which is no directory.
  const deepest = literal.endsWith("/") ? segments.length : segments.length - 1;
  for (let depth = deepest; depth > 0; depth--) {
    const candidate = `${segments.slice(0, depth).join("/")}/**`;
    if (candidate === pathPattern) continue;
    const filter = scope.pathFilter(candidate);
    if (filter && (await counter.count(filter)) > 0) return candidate;
  }
  return undefined;
}

function filtersToDrop(scope: EmptySearchScope): string[] {
  const drops = [
    ...(scope.presetFilterNotice ? [scope.presetFilterNotice.clearWith] : []),
    ...scope.narrowingParams.map((param) => (param === "filter" ? CLEAR_FILTER : param)),
  ];
  return [...new Set(drops)].slice(0, MAX_SUGGESTIONS);
}

function filteredOutMessage(scope: EmptySearchScope, drops: readonly string[]): string {
  const where = scope.pathPattern ? `pathPattern "${scope.pathPattern}"` : "the index";
  const notice = scope.presetFilterNotice;
  if (notice && scope.narrowingParams.length === 0) {
    return `${where} holds points, but rerank preset "${notice.preset}" default filter ${notice.by} removed every match; re-run with ${notice.clearWith}.`;
  }
  return `${where} holds points, but the filters removed every match; drop ${drops.join(" / ")}.`;
}
