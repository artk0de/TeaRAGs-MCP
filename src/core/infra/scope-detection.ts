import picomatch from "picomatch";

export type ChunkScope = "source" | "test" | null;

export interface ScopeDetectionConfig {
  testPaths?: string[];
  languageTestChunkCounts: Map<string, number>;
}

const DEFAULT_TEST_PATHS: Record<string, string[]> = {
  ruby: ["spec/**", "test/**"],
  typescript: ["tests/**", "test/**", "__tests__/**", "**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
  javascript: ["tests/**", "test/**", "__tests__/**", "**/*.test.js", "**/*.test.jsx", "**/*.spec.js", "**/*.spec.jsx"],
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
