import { isAbsolute } from "node:path";

import { classify } from "../../../infra/file-classification/index.js";

/**
 * Is this repo-relative path a test file? Delegates to the infra file
 * classifier, the ONE owner of test classification (bd tea-rags-mcp-9ty5z).
 * The codegraph exclusion and the enrichment policy's `skippedAs: "test"`
 * stamp read the same patterns, so `payload.isTest` can no longer disagree
 * with them. Path-aware: a support file under a test root (`tests/`, `spec/`,
 * `__tests__/`) counts, not only a `*.test.ts`-shaped name.
 *
 * `_language` keeps the call site's shape; the classifier's patterns carry
 * their own extensions, so the language adds nothing to the answer.
 *
 * A path the classifier cannot take (absolute, `..`-relative, empty; the
 * `ignore` matcher throws on those) answers false rather than failing the
 * payload build.
 */
export function detectTestFile(relativePath: string, _language?: string): boolean {
  if (relativePath === "" || isAbsolute(relativePath) || relativePath.startsWith("..")) return false;
  return classify(relativePath).isTest;
}
