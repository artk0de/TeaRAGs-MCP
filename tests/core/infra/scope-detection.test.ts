import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { languageTestFileConventions } from "../../../src/core/domains/language/capability/native.js";
import { classify } from "../../../src/core/infra/file-classification/index.js";
import { COMMON_TEST_DIRECTORY_PATTERNS } from "../../../src/core/infra/file-classification/patterns.js";
import { detectScope, isTestPath } from "../../../src/core/infra/scope-detection.js";

/** The classification corpus of the vjz6s parity baseline: every test pattern at depth, in three casings, plus near-misses. */
const CLASSIFICATION_CORPUS = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "file-classification/fixtures/test-path-classification-baseline.json"),
      "utf8",
    ),
  ) as { corpus: string[] }
).corpus;

describe("detectScope", () => {
  const noTestChunks = new Map<string, number>();
  const rubyHasTests = new Map([["ruby", 50]]);

  it("returns 'test' for chunkType=test regardless of path", () => {
    expect(detectScope("test", "src/app/service.rb", "ruby", { languageTestChunkCounts: rubyHasTests })).toBe("test");
  });

  it("returns null for chunkType=test_setup (excluded from both scopes)", () => {
    expect(
      detectScope("test_setup", "spec/models/user_spec.rb", "ruby", { languageTestChunkCounts: rubyHasTests }),
    ).toBeNull();
  });

  it("returns 'source' for chunkType=function in source path", () => {
    expect(detectScope("function", "src/app/service.rb", "ruby", { languageTestChunkCounts: rubyHasTests })).toBe(
      "source",
    );
  });

  it("returns 'test' via path fallback when language has 0 test chunks", () => {
    expect(detectScope("function", "spec/models/user_spec.rb", "ruby", { languageTestChunkCounts: noTestChunks })).toBe(
      "test",
    );
  });

  it("returns 'source' for test path when language has AST test detection", () => {
    expect(detectScope("function", "spec/models/user_spec.rb", "ruby", { languageTestChunkCounts: rubyHasTests })).toBe(
      "source",
    );
  });

  it("uses CODE_TEST_PATHS override when provided", () => {
    expect(
      detectScope("function", "custom_tests/foo.rb", "ruby", {
        testPaths: ["custom_tests/**"],
        languageTestChunkCounts: noTestChunks,
      }),
    ).toBe("test");
  });

  it("uses fallback test paths for unknown languages", () => {
    expect(detectScope("function", "test/foo.ex", "elixir", { languageTestChunkCounts: noTestChunks })).toBe("test");
  });

  it("returns 'source' for non-test path when language has 0 test chunks", () => {
    expect(detectScope("function", "src/app/service.rb", "ruby", { languageTestChunkCounts: noTestChunks })).toBe(
      "source",
    );
  });
});

describe("default test-path detection answers exactly what the file classifier answers (bd tea-rags-mcp-jl3ff)", () => {
  // One question — "is this path a test file?" — one answer. Scope detection
  // kept its own per-language glob table matched by picomatch, so it disagreed
  // with `classify().isTest` wherever the two matchers differ: case (SwiftPM's
  // `Tests/`, googletest's `parser_test.cc`), dot segments, and suffixes only
  // the scope table declared. The file was enriched as a test while its
  // signals landed in the SOURCE percentile bucket, or the reverse.
  const noTestChunks = new Map<string, number>();

  it.each([
    ["Tests/Helpers/Util.swift", "swift", true],
    ["Spec/models/user.rb", "ruby", true],
    ["src/Test/Foo.java", "java", true],
    ["src/parser_test.cc", "cpp", true],
    ["src/parser_test.c", "c", true],
    ["src/foo.TEST.ts", "typescript", true],
    ["tests/.helpers/x.py", "python", true],
    [".github/tests/run.ts", "typescript", true],
    ["lib/foo_test.exs", "elixir", false],
    ["lib/Latest.java", "java", false],
  ])("%s (%s) is a test path iff the classifier calls it a test", (relPath, language, expected) => {
    expect(classify(relPath).isTest).toBe(expected);
    expect(isTestPath(relPath, language)).toBe(expected);
    expect(detectScope("function", relPath, language, { languageTestChunkCounts: noTestChunks })).toBe(
      expected ? "test" : "source",
    );
  });

  it("agrees with classify().isTest on the whole classification corpus, for every language", () => {
    const languages = [...Object.keys(languageTestFileConventions()), "bash", "markdown", "brainfuck"];
    for (const relPath of CLASSIFICATION_CORPUS) {
      const expected = classify(relPath).isTest;
      for (const language of languages) {
        expect(isTestPath(relPath, language), `${language} ${relPath}`).toBe(expected);
      }
    }
  });

  it("treats an empty path as not a test path", () => {
    expect(isTestPath("", "ruby")).toBe(false);
    expect(detectScope("function", "", "ruby", { languageTestChunkCounts: noTestChunks })).toBe("source");
  });
});

/** A concrete path a `**`-prefixed test glob matches, at depth. */
function samplePathFor(pattern: string): string {
  return pattern
    .replace("**/*", "src/sample")
    .replace(/^\*\*\//, "pkg/")
    .replace(/\/\*\*$/, "/sample.x")
    .replaceAll("*", "sample");
}

describe("isTestPath", () => {
  it("flags ruby's spec and test directories", () => {
    expect(isTestPath("spec/models/user.rb", "ruby")).toBe(true);
    expect(isTestPath("test/models/user.rb", "ruby")).toBe(true);
  });

  it("flags typescript's __tests__ directory", () => {
    expect(isTestPath("src/__tests__/app.ts", "typescript")).toBe(true);
  });

  it("gives TypeScript's ESM / CJS module formats the TypeScript test suffixes (bd tea-rags-mcp-1y13c)", () => {
    // `.mts` / `.cts` are indexed as `typescript`, so a `worker.test.mts` chunk
    // scored as source and the secrets gate treated its fixtures as real code.
    for (const relPath of [
      "src/worker.test.mts",
      "src/worker.spec.mts",
      "src/loader.test.cts",
      "src/loader.spec.cts",
    ]) {
      expect(isTestPath(relPath, "typescript"), relPath).toBe(true);
      expect(detectScope("function", relPath, "typescript", { languageTestChunkCounts: new Map() }), relPath).toBe(
        "test",
      );
    }
    expect(isTestPath("src/worker.mts", "typescript")).toBe(false);
    expect(isTestPath("src/loader.cts", "typescript")).toBe(false);
  });

  it("agrees with the file classifier on every TypeScript and JavaScript test suffix", () => {
    // Every suffix the file classifier calls a test in these languages is a
    // test path here too — one fact, so the two answers cannot drift apart.
    for (const language of ["typescript", "javascript"]) {
      for (const pattern of languageTestFileConventions()[language].patterns) {
        const relPath = pattern.replace("**/*", "src/sample");
        expect(isTestPath(relPath, language), `${language} ${relPath}`).toBe(true);
      }
    }
  });

  it("flags every installed language's test shapes and the shared test directories (bd tea-rags-mcp-jl3ff)", () => {
    // One table answers "is this path a test file in language X" for both the
    // file classifier and scope detection: the shared directory conventions
    // plus the language's own suffixes. A hand copy here drifted to
    // root-anchored globs and disagreed with the classifier on nested layouts.
    for (const [language, { patterns: suffixes }] of Object.entries(languageTestFileConventions())) {
      for (const pattern of [...COMMON_TEST_DIRECTORY_PATTERNS, ...suffixes]) {
        expect(isTestPath(samplePathFor(pattern), language), `${language} ${pattern}`).toBe(true);
      }
    }
  });

  it("flags nested test directories and suffix-named specs the classifier calls tests (bd tea-rags-mcp-jl3ff)", () => {
    // Rails engines / monorepo layouts: the classifier enriched these as tests
    // while scope detection dropped their signals into the SOURCE bucket.
    expect(isTestPath("engines/billing/spec/models/user_spec.rb", "ruby")).toBe(true);
    expect(isTestPath("lib/foo_spec.rb", "ruby")).toBe(true);
    expect(isTestPath("packages/api/tests/test_views.py", "python")).toBe(true);
    expect(isTestPath("packages/web/__tests__/app.ts", "typescript")).toBe(true);
    expect(isTestPath("lib/foo.rb", "ruby")).toBe(false);
  });

  it("falls back to the language-agnostic test directories for an unknown language", () => {
    for (const pattern of COMMON_TEST_DIRECTORY_PATTERNS) {
      expect(isTestPath(samplePathFor(pattern), "brainfuck"), pattern).toBe(true);
    }
    expect(isTestPath("src/sample.bf", "brainfuck")).toBe(false);
  });
});
