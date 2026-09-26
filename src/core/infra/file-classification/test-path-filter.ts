import ignore from "ignore";

import type { TestFileConventions } from "../../contracts/types/file-classification.js";
import { installedTestFileConventions, testPathPatterns } from "./test-file-conventions.js";

/** The one question every test-path consumer asks, in the `ignore` package's shape. */
export interface PathFilter {
  ignores: (relPath: string) => boolean;
}

/**
 * Matches a repo-relative path against the conventional test-file shapes: the
 * language-agnostic test directories plus every language's own file shapes
 * (`conventions`, owned by `domains/language`; the installed ones by default).
 *
 * `ignore` decides case sensitivity per instance, not per pattern, so the
 * patterns split across two: PascalCase suffixes case-sensitive, everything
 * else case-insensitive (bd tea-rags-mcp-ezm9o). Both the classifier's
 * `isTest` and the codegraph exclusion build on this, so they cannot disagree
 * on what a test is.
 */
export function buildTestPathFilter(conventions: TestFileConventions = installedTestFileConventions()): PathFilter {
  const patterns = testPathPatterns(conventions);
  const caseInsensitive = ignore().add([...patterns.caseInsensitive]);
  const caseSensitive = ignore({ ignorecase: false }).add([...patterns.caseSensitive]);
  return { ignores: (relPath) => caseInsensitive.ignores(relPath) || caseSensitive.ignores(relPath) };
}
