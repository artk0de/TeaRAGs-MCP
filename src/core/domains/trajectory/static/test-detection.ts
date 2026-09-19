import { basename } from "node:path";

/**
 * `.test` / `.spec` before any TypeScript or JavaScript extension, the ESM /
 * CJS module formats included — `.mts` / `.cts` are indexed as TypeScript (bd
 * tea-rags-mcp-1y13c).
 */
const ECMASCRIPT_TEST_FILE = /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const TEST_PATTERNS: Record<string, RegExp> = {
  typescript: ECMASCRIPT_TEST_FILE,
  javascript: ECMASCRIPT_TEST_FILE,
  python: /(^|[\\/])test_.*\.py$|_test\.py$/,
  java: /(Test|IT)\.java$/,
  go: /_test\.go$/,
  rust: /_test\.rs$/,
  ruby: /_(spec|test)\.rb$/,
  php: /Test\.php$/,
  c_sharp: /[Tt]ests?\.cs$/,
  cpp: /[Tt]ests?\.(cpp|cc|cxx)$/,
  c: /[Tt]ests?\.c$/,
  swift: /Tests?\.swift$/,
  kotlin: /Test\.kt$/,
  dart: /_test\.dart$/,
  scala: /(Spec|Test)\.scala$/,
  clojure: /_test\.clj[s]?$/,
};

/**
 * Detect whether a file is a test/spec file based on naming convention per language.
 * Matches on file name only (not directory).
 */
export function detectTestFile(relativePath: string, language: string): boolean {
  const pattern = TEST_PATTERNS[language];
  if (!pattern) return false;
  const fileName = basename(relativePath);
  return pattern.test(fileName);
}
