import type { QdrantFilterCondition } from "../../../adapters/qdrant/types.js";
import type { AdaptiveFilterCondition } from "../../../contracts/types/filter-preset.js";

/**
 * The Qdrant `must_not` conditions that exclude test files: the ONE owner of
 * "exclude tests" on the query path. The typed `testFile: "exclude"` param
 * (`static/filters.ts`) emits them and the filter-preset compiler expands every
 * {@link isTestExclusionCondition} into them, so a preset and the param cannot
 * disagree about what "no tests" means.
 *
 * `codegraph.symbols.file.skippedAs = "test"` is a bridge (bd
 * tea-rags-mcp-9ty5z): indexes built before `isTest` became path-aware lack it
 * on test-root support files (`tests/**\/__helpers__/…`), which the codegraph
 * policy already stamped from the same classifier. A `must_not` on an absent
 * key excludes nothing, so an index without codegraph is unaffected. Drop the
 * bridge once indexes built before 9ty5z are gone (`--force` rewrites `isTest`).
 */
// Inferred literal type (checked by `satisfies`) rather than an annotation: the
// literal shapes assign both to the adapter's `QdrantFilterCondition` (preset
// compiler) and to the contracts' index-signature shape (`FilterConditionResult`).
export const TEST_EXCLUSION_FILTER_CONDITIONS = [
  { key: "isTest", match: { value: true } },
  { key: "codegraph.symbols.file.skippedAs", match: { value: "test" } },
] satisfies readonly QdrantFilterCondition[];

/** A preset condition that excludes test files: `isTest eq true`, occur `must_not`. */
export function isTestExclusionCondition(c: AdaptiveFilterCondition): boolean {
  return c.signal === "isTest" && c.op === "eq" && c.value === true && c.occur === "must_not";
}
