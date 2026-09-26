import ignore from "ignore";

import { NON_PRODUCTION_PATTERNS } from "./patterns.js";
import { buildTestPathFilter, type PathFilter } from "./test-path-filter.js";

/**
 * Matches a repo-relative path that is source code but not the product: the
 * development tooling of {@link NON_PRODUCTION_PATTERNS} — scripts, spikes,
 * benchmarks, examples, fixtures (bd tea-rags-mcp-r8hme.9) — and the test
 * shapes of {@link buildTestPathFilter}. Case-insensitive, like the test shapes
 * (PascalCase test suffixes keep their case-sensitive match).
 *
 * The ONE non-production predicate: the architecture report judges the
 * production file graph through it, and the ontology report scopes
 * `cg_identifiers` through it (bd tea-rags-mcp-4p3sb.25). Both read tables the
 * codegraph walk wrote, and that walk already drops test files
 * (`buildCodegraphExclusionFilter`), so for them the test half is the walk's
 * own exclusion restated at read time — the two reports cannot disagree about
 * a row the walk let through. Lives in `infra` because the codegraph trajectory
 * and the DuckDB adapter both need it and neither may import the other.
 */
export function buildNonProductionPathFilter(): PathFilter {
  const tooling = ignore().add(NON_PRODUCTION_PATTERNS);
  const tests = buildTestPathFilter();
  return { ignores: (relPath) => tooling.ignores(relPath) || tests.ignores(relPath) };
}
