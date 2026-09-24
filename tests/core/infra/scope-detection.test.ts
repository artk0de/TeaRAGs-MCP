import { describe, expect, it } from "vitest";

import { TEST_PATTERNS_BY_LANGUAGE } from "../../../src/core/infra/file-classification/patterns.js";
import { detectScope, getDefaultTestPaths, isTestPath } from "../../../src/core/infra/scope-detection.js";

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

describe("getDefaultTestPaths", () => {
  it("returns ruby-specific paths for ruby", () => {
    const paths = getDefaultTestPaths("ruby");
    expect(paths).toContain("**/spec/**");
    expect(paths).toContain("**/test/**");
  });

  it("returns typescript-specific paths for typescript", () => {
    const paths = getDefaultTestPaths("typescript");
    expect(paths).toContain("**/__tests__/**");
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
      for (const pattern of TEST_PATTERNS_BY_LANGUAGE[language]) {
        const relPath = pattern.replace("**/*", "src/sample");
        expect(isTestPath(relPath, language), `${language} ${relPath}`).toBe(true);
      }
    }
  });

  it("derives every classifier language's test paths from TEST_PATTERNS_BY_LANGUAGE (bd tea-rags-mcp-jl3ff)", () => {
    // One table answers "is this path a test file in language X" for both the
    // file classifier and scope detection: the shared directory conventions
    // plus the language's own suffixes. A hand copy here drifted to
    // root-anchored globs and disagreed with the classifier on nested layouts.
    const { common, ...byLanguage } = TEST_PATTERNS_BY_LANGUAGE;
    for (const [language, suffixes] of Object.entries(byLanguage)) {
      expect(getDefaultTestPaths(language), language).toEqual([...common, ...suffixes]);
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
    expect(getDefaultTestPaths("brainfuck")).toEqual([...TEST_PATTERNS_BY_LANGUAGE.common]);
  });

  it("returns fallback paths for unknown language", () => {
    const paths = getDefaultTestPaths("brainfuck");
    expect(paths.length).toBeGreaterThan(0);
  });
});
