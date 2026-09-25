import picomatch from "picomatch";

import { TEST_PATTERNS_BY_LANGUAGE } from "./file-classification/patterns.js";

export type ChunkScope = "source" | "test" | null;

export interface ScopeDetectionConfig {
  testPaths?: string[];
  languageTestChunkCounts: Map<string, number>;
}

/**
 * Default test paths are DERIVED from `TEST_PATTERNS_BY_LANGUAGE`, the file
 * classifier's per-language table: its language-agnostic `common` directories
 * plus the language's own suffixes. A hand copy here drifted twice — it missed
 * TypeScript's `.mts` / `.cts` suffixes (bd tea-rags-mcp-1y13c), and its
 * root-anchored `spec/` glob disagreed with the classifier's any-depth one on
 * nested layouts (bd tea-rags-mcp-jl3ff): a Rails-engine spec was enriched as a
 * test while its signals landed in the SOURCE percentile bucket.
 */
const { common: COMMON_TEST_DIRECTORIES, ...TEST_SUFFIXES_BY_LANGUAGE } = TEST_PATTERNS_BY_LANGUAGE;

/**
 * Suffix conventions for languages the classifier table does not carry yet.
 * They stay scope-detection-only because moving them into the table would also
 * change what the classifier calls a test — git enrichment policy and codegraph
 * exclusion — which is a separate decision (see bd tea-rags-mcp-jl3ff).
 * Directory conventions are NOT repeated here: `COMMON_TEST_DIRECTORIES` covers
 * them for every language.
 */
const SCOPE_ONLY_TEST_SUFFIXES: Readonly<Record<string, readonly string[]>> = {
  csharp: ["**/*.Tests/**", "**/Tests/**", "**/*Test.cs", "**/*Tests.cs"],
  swift: ["**/Tests/**", "**/*Tests.swift"],
  php: ["**/*Test.php"],
  elixir: ["**/*_test.exs"],
};

const DEFAULT_TEST_PATHS: Readonly<Record<string, string[]>> = Object.fromEntries(
  Object.entries({ ...SCOPE_ONLY_TEST_SUFFIXES, ...TEST_SUFFIXES_BY_LANGUAGE }).map(([language, suffixes]) => [
    language,
    [...COMMON_TEST_DIRECTORIES, ...suffixes],
  ]),
);

const FALLBACK_TEST_PATHS = [...COMMON_TEST_DIRECTORIES];

export function getDefaultTestPaths(language: string): string[] {
  return DEFAULT_TEST_PATHS[language] ?? FALLBACK_TEST_PATHS;
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
