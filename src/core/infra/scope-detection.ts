import picomatch from "picomatch";

import { TEST_PATTERNS_BY_LANGUAGE } from "./file-classification/patterns.js";

export type ChunkScope = "source" | "test" | null;

export interface ScopeDetectionConfig {
  testPaths?: string[];
  languageTestChunkCounts: Map<string, number>;
}

/** Root-level test directories shared by the TypeScript and JavaScript entries. */
const ECMASCRIPT_TEST_DIRECTORIES = ["tests/**", "test/**", "__tests__/**"];

/**
 * TypeScript and JavaScript take their test-file SUFFIXES from
 * `TEST_PATTERNS_BY_LANGUAGE`, the classifier's per-language source, rather
 * than a copy: the copy here missed `.mts` / `.cts` once TypeScript owned them
 * (bd tea-rags-mcp-1y13c), so a `worker.test.mts` chunk scored as source and
 * went through the secrets gate as real code.
 */
const DEFAULT_TEST_PATHS: Record<string, string[]> = {
  ruby: ["spec/**", "test/**"],
  typescript: [...ECMASCRIPT_TEST_DIRECTORIES, ...TEST_PATTERNS_BY_LANGUAGE.typescript],
  javascript: [...ECMASCRIPT_TEST_DIRECTORIES, ...TEST_PATTERNS_BY_LANGUAGE.javascript],
  python: ["tests/**", "test/**", "**/test_*.py", "**/*_test.py"],
  go: ["**/*_test.go"],
  java: ["src/test/**", "**/test/**"],
  kotlin: ["src/test/**", "**/test/**"],
  csharp: ["**/*.Tests/**", "**/Tests/**", "**/*Test.cs", "**/*Tests.cs"],
  swift: ["**/Tests/**", "**/*Tests.swift"],
  php: ["tests/**", "test/**", "**/*Test.php"],
  elixir: ["test/**", "**/*_test.exs"],
  scala: ["src/test/**", "**/test/**"],
};

const FALLBACK_TEST_PATHS = ["test/**", "tests/**", "spec/**", "__tests__/**"];

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
