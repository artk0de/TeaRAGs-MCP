import { describe, expect, it } from "vitest";

import { TEST_PATTERNS, TEST_PATTERNS_BY_LANGUAGE } from "../../../../src/core/infra/file-classification/patterns.js";

// The canonical pre-relocation flat TEST_PATTERNS set. The per-language
// reorganization MUST stay lossless against this — no test-file shape dropped,
// none added (substrate spec backward-compat invariant).
const CANONICAL_TEST_PATTERNS = [
  "**/tests/**",
  "**/test/**",
  "**/__tests__/**",
  "**/spec/**",
  "**/*.test.js",
  "**/*.test.jsx",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.mjs",
  "**/*.test.cjs",
  "**/*.spec.js",
  "**/*.spec.jsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*.spec.mjs",
  "**/*.spec.cjs",
  "**/test_*.py",
  "**/*_test.py",
  "**/conftest.py",
  "**/*_test.rb",
  "**/*_spec.rb",
  "**/*Test.java",
  "**/*Tests.java",
  "**/*IT.java",
  "**/*_test.go",
  "**/*_test.rs",
];

describe("TEST_PATTERNS_BY_LANGUAGE — per-language test path patterns (in infra)", () => {
  it("groups patterns by code language plus a language-agnostic `common` bucket", () => {
    // Code-language buckets the byLanguage codegraph metric will key off.
    for (const lang of ["typescript", "javascript", "python", "ruby", "java", "go", "rust"]) {
      expect(TEST_PATTERNS_BY_LANGUAGE[lang], `${lang} bucket`).toBeDefined();
      expect(TEST_PATTERNS_BY_LANGUAGE[lang]!.length).toBeGreaterThan(0);
    }
    // Directory conventions are language-agnostic.
    expect(TEST_PATTERNS_BY_LANGUAGE.common).toContain("**/spec/**");
  });

  it("assigns each language its own suffix conventions", () => {
    expect(TEST_PATTERNS_BY_LANGUAGE.ruby).toEqual(["**/*_test.rb", "**/*_spec.rb"]);
    expect(TEST_PATTERNS_BY_LANGUAGE.go).toEqual(["**/*_test.go"]);
    expect(TEST_PATTERNS_BY_LANGUAGE.python).toContain("**/conftest.py");
    expect(TEST_PATTERNS_BY_LANGUAGE.typescript).toContain("**/*.test.ts");
    expect(TEST_PATTERNS_BY_LANGUAGE.java).toContain("**/*IT.java");
  });

  it("derives flat TEST_PATTERNS as the deduped union of all buckets — lossless vs canonical", () => {
    const union = new Set(Object.values(TEST_PATTERNS_BY_LANGUAGE).flat());
    expect(new Set(TEST_PATTERNS)).toEqual(union);
    // Provably lossless: the flat set equals the pre-change canonical set.
    expect(new Set(TEST_PATTERNS)).toEqual(new Set(CANONICAL_TEST_PATTERNS));
  });

  it("contains no duplicate patterns in the flat list", () => {
    expect(TEST_PATTERNS.length).toBe(new Set(TEST_PATTERNS).size);
  });
});
