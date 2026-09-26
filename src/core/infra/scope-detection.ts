import { isAbsolute } from "node:path";

import picomatch from "picomatch";

import { matchesTestFileConventions } from "./file-classification/classify.js";

export type ChunkScope = "source" | "test" | null;

export interface ScopeDetectionConfig {
  testPaths?: string[];
  languageTestChunkCounts: Map<string, number>;
}

/**
 * Whether a path is a test file by its path alone — the file classifier's
 * answer (`classify().isTest`), not a table of its own (bd tea-rags-mcp-jl3ff).
 *
 * Scope detection used to keep a per-language glob table matched by picomatch.
 * Even derived from the same conventions it answered differently: picomatch is
 * case-sensitive and skips dot segments where the classifier's matcher is not
 * (SwiftPM's `Tests/`, googletest's `parser_test.cc`, `tests/.helpers/`), and it
 * carried suffixes the classifier did not. A file was then enriched as a test
 * while its signals landed in the SOURCE percentile bucket, or the reverse.
 * `language` is accepted for the call shape only: every test-file shape names
 * its own extension, so the classifier's all-language union is the language's.
 *
 * A path that is not repo-relative is no test path; the classifier's matcher
 * throws on one.
 */
export function isTestPath(relativePath: string, _language?: string): boolean {
  if (relativePath === "" || isAbsolute(relativePath) || relativePath.startsWith("..")) return false;
  return matchesTestFileConventions(relativePath);
}

export function detectScope(
  chunkType: string | undefined,
  relativePath: string,
  language: string,
  config: ScopeDetectionConfig,
): ChunkScope {
  if (chunkType === "test") return "test";
  if (chunkType === "test_setup") return null;

  const pathIsTest = config.testPaths
    ? config.testPaths.some((pattern) => picomatch.isMatch(relativePath, pattern))
    : isTestPath(relativePath, language);

  if (pathIsTest) {
    const langTestCount = config.languageTestChunkCounts.get(language) ?? 0;
    if (langTestCount > 0) {
      // Language has AST test detection — trust chunkType over path.
      // Non-test chunkTypes in test dirs (helpers, factories) count as source.
      return "source";
    }
    return "test";
  }

  return "source";
}
