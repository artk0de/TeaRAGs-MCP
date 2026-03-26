import { describe, expect, it } from "vitest";

import { detectScope, getDefaultTestPaths } from "../../../src/core/infra/scope-detection.js";

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
    expect(paths).toContain("spec/**");
    expect(paths).toContain("test/**");
  });

  it("returns typescript-specific paths for typescript", () => {
    const paths = getDefaultTestPaths("typescript");
    expect(paths).toContain("__tests__/**");
  });

  it("returns fallback paths for unknown language", () => {
    const paths = getDefaultTestPaths("brainfuck");
    expect(paths.length).toBeGreaterThan(0);
  });
});
