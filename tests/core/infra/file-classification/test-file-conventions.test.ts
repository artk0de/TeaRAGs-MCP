/**
 * The installed test-file conventions (bd tea-rags-mcp-vjz6s): `infra` imports
 * nothing, so the per-language masks `domains/language` owns reach the
 * classifier by injection — each composition root installs them once, and the
 * module-level readers (`classify`, `detectScope`) answer from what was
 * installed. Never from a silent default: an uninstalled read throws.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TestFileConventions } from "../../../../src/core/contracts/types/file-classification.js";

async function freshModules() {
  vi.resetModules();
  const conventions = await import("../../../../src/core/infra/file-classification/test-file-conventions.js");
  const classifier = await import("../../../../src/core/infra/file-classification/classify.js");
  const scope = await import("../../../../src/core/infra/scope-detection.js");
  return { ...conventions, ...classifier, ...scope };
}

const GO_ONLY: TestFileConventions = { go: { patterns: ["**/*_test.go"] } };

describe("installTestFileConventions / installedTestFileConventions", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("an uninstalled read throws instead of classifying with no language masks", async () => {
    const { installedTestFileConventions, classify } = await freshModules();
    expect(() => installedTestFileConventions()).toThrow(/installTestFileConventions/);
    expect(() => classify("pkg/repo_test.go")).toThrow(/installTestFileConventions/);
  });

  it("classify and scope detection answer from what was installed", async () => {
    const { installTestFileConventions, classify, getDefaultTestPaths, isTestPath } = await freshModules();
    installTestFileConventions(GO_ONLY);
    expect(classify("pkg/repo_test.go").isTest).toBe(true);
    // Not installed: no TypeScript mask, only the language-agnostic directories.
    expect(classify("src/app.test.ts").isTest).toBe(false);
    expect(classify("tests/app.ts").isTest).toBe(true);
    expect(getDefaultTestPaths("go")).toEqual([
      "**/tests/**",
      "**/test/**",
      "**/__tests__/**",
      "**/spec/**",
      "**/*_test.go",
    ]);
    expect(isTestPath("pkg/repo_test.go", "go")).toBe(true);
  });

  it("a re-install replaces the conventions every reader answers from", async () => {
    const { installTestFileConventions, classify, isTestPath } = await freshModules();
    installTestFileConventions(GO_ONLY);
    expect(classify("src/app.test.ts").isTest).toBe(false);
    installTestFileConventions({ typescript: { patterns: ["**/*.test.ts"] } });
    expect(classify("src/app.test.ts").isTest).toBe(true);
    expect(classify("pkg/repo_test.go").isTest).toBe(false);
    expect(isTestPath("src/app.test.ts", "typescript")).toBe(true);
  });
});

describe("testPathPatterns", () => {
  it("adds the language-agnostic directories and splits PascalCase suffixes out as case-sensitive", async () => {
    const { testPathPatterns } = await freshModules();
    const sets = testPathPatterns({
      java: { patterns: ["**/*Test.java"] },
      cpp: { patterns: ["**/*Test.cc"], mixedCaseSuffixes: true },
      go: { patterns: ["**/*_test.go"] },
    });
    expect(sets.caseSensitive).toEqual(["**/*Test.java"]);
    expect(sets.caseInsensitive).toEqual([
      "**/tests/**",
      "**/test/**",
      "**/__tests__/**",
      "**/spec/**",
      "**/*Test.cc",
      "**/*_test.go",
    ]);
    expect(new Set(sets.all)).toEqual(new Set([...sets.caseSensitive, ...sets.caseInsensitive]));
  });
});
