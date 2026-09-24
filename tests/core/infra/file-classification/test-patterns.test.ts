import { describe, expect, it } from "vitest";

import {
  CASE_INSENSITIVE_TEST_PATTERNS,
  CASE_SENSITIVE_TEST_PATTERNS,
  TEST_PATTERNS,
  TEST_PATTERNS_BY_LANGUAGE,
} from "../../../../src/core/infra/file-classification/patterns.js";

// The canonical pre-relocation flat TEST_PATTERNS set. The per-language
// reorganization MUST stay lossless against this — no test-file shape dropped,
// none added (substrate spec backward-compat invariant). One deliberate
// addition since: TypeScript's ESM / CJS module formats (`.mts` / `.cts`),
// which ingest and the codegraph index as TypeScript (bd tea-rags-mcp-1y13c),
// carry TypeScript's own test suffixes. A second: the languages only the
// retired static-trajectory basename regex knew (php … clojure), folded in when
// `payload.isTest` moved onto this classifier (bd tea-rags-mcp-9ty5z).
const CANONICAL_TEST_PATTERNS = [
  "**/tests/**",
  "**/test/**",
  "**/__tests__/**",
  "**/spec/**",
  "**/*.test.js",
  "**/*.test.jsx",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.mts",
  "**/*.test.cts",
  "**/*.test.mjs",
  "**/*.test.cjs",
  "**/*.spec.js",
  "**/*.spec.jsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*.spec.mts",
  "**/*.spec.cts",
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
  "**/*Test.php",
  "**/*Test.cs",
  "**/*Tests.cs",
  "**/*Test.cpp",
  "**/*Tests.cpp",
  "**/*Test.cc",
  "**/*Tests.cc",
  "**/*Test.cxx",
  "**/*Tests.cxx",
  "**/*Test.c",
  "**/*Tests.c",
  "**/*Test.swift",
  "**/*Tests.swift",
  "**/*Test.kt",
  "**/*_test.dart",
  "**/*Spec.scala",
  "**/*Test.scala",
  "**/*_test.clj",
  "**/*_test.cljs",
];

describe("TEST_PATTERNS_BY_LANGUAGE — per-language test path patterns (in infra)", () => {
  it("groups patterns by code language plus a language-agnostic `common` bucket", () => {
    // Code-language buckets the byLanguage codegraph metric will key off.
    for (const lang of ["typescript", "javascript", "python", "ruby", "java", "go", "rust"]) {
      expect(TEST_PATTERNS_BY_LANGUAGE[lang], `${lang} bucket`).toBeDefined();
      expect(TEST_PATTERNS_BY_LANGUAGE[lang].length).toBeGreaterThan(0);
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

  it("partitions the flat list by case sensitivity — PascalCase suffixes only (bd tea-rags-mcp-ezm9o)", () => {
    const sensitive = new Set(CASE_SENSITIVE_TEST_PATTERNS);
    expect(new Set([...CASE_SENSITIVE_TEST_PATTERNS, ...CASE_INSENSITIVE_TEST_PATTERNS])).toEqual(
      new Set(TEST_PATTERNS),
    );
    expect(CASE_INSENSITIVE_TEST_PATTERNS.filter((p) => sensitive.has(p))).toEqual([]);
    for (const p of ["**/*Test.java", "**/*IT.java", "**/*Test.kt", "**/*Tests.swift", "**/*Tests.cs"]) {
      expect(sensitive.has(p), p).toBe(true);
    }
    for (const p of ["**/*Spec.scala", "**/*Test.php"]) expect(sensitive.has(p), p).toBe(true);
    // Directories, lowercase conventions and the mixed-case C / C++ suffixes stay case-insensitive.
    for (const p of [
      ...TEST_PATTERNS_BY_LANGUAGE.common,
      "**/*_test.go",
      "**/*.spec.ts",
      "**/*Test.cc",
      "**/*Tests.c",
    ]) {
      expect(sensitive.has(p), p).toBe(false);
    }
  });
});
