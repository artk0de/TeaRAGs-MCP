import ignore from "ignore";

import type { CaseSplitPathPatterns, TestFileConventions } from "../../contracts/types/file-classification.js";
import { NON_PRODUCTION_PATTERNS } from "./patterns.js";
import { installedTestFileConventions, testPathPatterns } from "./test-file-conventions.js";
import { buildTestPathFilter, type PathFilter } from "./test-path-filter.js";

/**
 * The non-production masks as pattern lists split by case matching — the input
 * of both {@link buildNonProductionPathFilter} and the DuckDB predicate
 * (`compileNonProductionPathPredicate`, `adapters/duckdb`), so the two cannot
 * drift: tooling directories and the case-insensitive test shapes ignoring
 * case, the PascalCase test suffixes (`*Test.java`) matching it exactly.
 */
export function nonProductionPathPatterns(
  conventions: TestFileConventions = installedTestFileConventions(),
): CaseSplitPathPatterns {
  const tests = testPathPatterns(conventions);
  return {
    caseInsensitive: [...NON_PRODUCTION_PATTERNS, ...tests.caseInsensitive],
    caseSensitive: tests.caseSensitive,
  };
}

/**
 * Matches a repo-relative path that is source code but not the product: the
 * development tooling of {@link NON_PRODUCTION_PATTERNS} — scripts, spikes,
 * benchmarks, examples, fixtures (bd tea-rags-mcp-r8hme.9) — and the test
 * shapes of {@link buildTestPathFilter} over `conventions` (the installed ones
 * by default). Case-insensitive, like the test shapes (PascalCase test suffixes
 * keep their case-sensitive match).
 *
 * The ONE non-production predicate: the architecture report judges the
 * production file graph through it, and the ontology report scopes
 * `cg_identifiers` through its SQL form ({@link nonProductionPathPatterns},
 * bd tea-rags-mcp-4p3sb.25). Both read tables the codegraph walk wrote, and that
 * walk already drops test files (`buildCodegraphExclusionFilter`), so for them
 * the test half is the walk's own exclusion restated at read time — the two
 * reports cannot disagree about a row the walk let through. Lives in `infra`
 * because the codegraph trajectory and the DuckDB adapter both need it and
 * neither may import the other.
 */
export function buildNonProductionPathFilter(
  conventions: TestFileConventions = installedTestFileConventions(),
): PathFilter {
  const tooling = ignore().add([...NON_PRODUCTION_PATTERNS]);
  const tests = buildTestPathFilter(conventions);
  return { ignores: (relPath) => tooling.ignores(relPath) || tests.ignores(relPath) };
}
