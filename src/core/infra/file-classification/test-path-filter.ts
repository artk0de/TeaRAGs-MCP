import ignore from "ignore";

import { CASE_INSENSITIVE_TEST_PATTERNS, CASE_SENSITIVE_TEST_PATTERNS } from "./patterns.js";

/** The one question every test-path consumer asks, in the `ignore` package's shape. */
export interface PathFilter {
  ignores: (relPath: string) => boolean;
}

/**
 * Matches a repo-relative path against the conventional test-file shapes.
 *
 * `ignore` decides case sensitivity per instance, not per pattern, so the
 * patterns split across two: PascalCase suffixes case-sensitive, everything
 * else case-insensitive (bd tea-rags-mcp-ezm9o). Both the classifier's
 * `isTest` and the codegraph exclusion build on this, so they cannot disagree
 * on what a test is.
 */
export function buildTestPathFilter(): PathFilter {
  const caseInsensitive = ignore().add(CASE_INSENSITIVE_TEST_PATTERNS);
  const caseSensitive = ignore({ ignorecase: false }).add(CASE_SENSITIVE_TEST_PATTERNS);
  return { ignores: (relPath) => caseInsensitive.ignores(relPath) || caseSensitive.ignores(relPath) };
}
