import picomatch from "picomatch";

import type { TestFileConventions } from "../contracts/types/file-classification.js";
import { COMMON_TEST_DIRECTORY_PATTERNS } from "./file-classification/patterns.js";
import { installedTestFileConventions } from "./file-classification/test-file-conventions.js";

export type ChunkScope = "source" | "test" | null;

export interface ScopeDetectionConfig {
  testPaths?: string[];
  languageTestChunkCounts: Map<string, number>;
}

/**
 * Suffix conventions for languages the classifier's conventions do not carry
 * yet. They stay scope-detection-only because moving them into the
 * conventions would also change what the classifier calls a test — git
 * enrichment policy and codegraph exclusion — which is a separate decision
 * (see bd tea-rags-mcp-jl3ff). Only languages with no `domains/language`
 * vertical belong here (a vertical declares its masks in its own directory,
 * bd tea-rags-mcp-vjz6s), and a key the conventions also carry is overridden
 * by them. Directory conventions are NOT repeated here:
 * `COMMON_TEST_DIRECTORY_PATTERNS` covers them for every language.
 */
const SCOPE_ONLY_TEST_SUFFIXES: Readonly<Record<string, readonly string[]>> = {
  csharp: ["**/*.Tests/**", "**/Tests/**", "**/*Test.cs", "**/*Tests.cs"],
  elixir: ["**/*_test.exs"],
};

/** Default test paths, derived for the conventions installed when they were derived. */
let defaultTestPaths: { conventions: TestFileConventions; byLanguage: Readonly<Record<string, string[]>> } | undefined;

/**
 * Default test paths are DERIVED from the file classifier's installed
 * per-language test-file conventions: the language-agnostic test directories
 * plus the language's own file shapes. A hand copy here drifted twice — it
 * missed TypeScript's `.mts` / `.cts` suffixes (bd tea-rags-mcp-1y13c), and its
 * root-anchored `spec/` glob disagreed with the classifier's any-depth one on
 * nested layouts (bd tea-rags-mcp-jl3ff): a Rails-engine spec was enriched as a
 * test while its signals landed in the SOURCE percentile bucket.
 */
function defaultTestPathsByLanguage(): Readonly<Record<string, string[]>> {
  const conventions = installedTestFileConventions();
  if (defaultTestPaths?.conventions !== conventions) {
    const suffixes: Record<string, readonly string[]> = { ...SCOPE_ONLY_TEST_SUFFIXES };
    for (const [language, convention] of Object.entries(conventions)) suffixes[language] = convention.patterns;
    const byLanguage = Object.fromEntries(
      Object.entries(suffixes).map(([language, patterns]) => [
        language,
        [...COMMON_TEST_DIRECTORY_PATTERNS, ...patterns],
      ]),
    );
    defaultTestPaths = { conventions, byLanguage };
  }
  return defaultTestPaths.byLanguage;
}

export function getDefaultTestPaths(language: string): string[] {
  return defaultTestPathsByLanguage()[language] ?? [...COMMON_TEST_DIRECTORY_PATTERNS];
}

/** Check if a relative path matches test directory patterns for the given language. */
export function isTestPath(relativePath: string, language: string): boolean {
  const patterns = getDefaultTestPaths(language);
  return patterns.some((pattern) => picomatch.isMatch(relativePath, pattern));
}

export function detectScope(
  chunkType: string | undefined,
  relativePath: string,
  language: string,
  config: ScopeDetectionConfig,
): ChunkScope {
  if (chunkType === "test") return "test";
  if (chunkType === "test_setup") return null;

  const testPaths = config.testPaths ?? getDefaultTestPaths(language);
  const isTestPath = testPaths.some((pattern) => picomatch.isMatch(relativePath, pattern));

  if (isTestPath) {
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
