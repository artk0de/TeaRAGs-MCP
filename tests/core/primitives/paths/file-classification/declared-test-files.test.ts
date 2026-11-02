import { afterEach, describe, expect, it } from "vitest";

import {
  classify,
  installDeclaredTestFiles,
  installedDeclaredTestFiles,
  isDeclaredTestFile,
  matchesTestFileConventions,
} from "../../../../../src/core/primitives/paths/file-classification/index.js";

describe("declared test files (bd tea-rags-mcp-52wk3.10)", () => {
  afterEach(() => {
    installDeclaredTestFiles("/repo/a", []);
    installDeclaredTestFiles("/repo/b", []);
  });

  it("classifies exactly as before when nothing is installed", () => {
    expect(isDeclaredTestFile("crates/searcher/src/testutil.rs")).toBe(false);
    expect(classify("crates/searcher/src/testutil.rs").isTest).toBe(false);
  });

  it("raises isTest for a path a project declared, keeping it source", () => {
    installDeclaredTestFiles("/repo/a", ["crates/searcher/src/testutil.rs"]);
    const classification = classify("crates/searcher/src/testutil.rs");
    expect(classification.isTest).toBe(true);
    expect(classification.isSource).toBe(true);
    expect(classify("crates/searcher/src/searcher.rs").isTest).toBe(false);
    // The conventions answer stays the conventions'.
    expect(matchesTestFileConventions("crates/searcher/src/testutil.rs")).toBe(false);
  });

  it("answers for the latest run only — an earlier project's set never leaks into the next", () => {
    installDeclaredTestFiles("/repo/a", ["src/test_utils.rs"]);
    expect(isDeclaredTestFile("src/test_utils.rs")).toBe(true);
    installDeclaredTestFiles("/repo/b", ["src/b.rs"]);
    expect(isDeclaredTestFile("src/test_utils.rs")).toBe(false);
    expect(isDeclaredTestFile("src/b.rs")).toBe(true);
    expect(installedDeclaredTestFiles("/repo/b")).toEqual(["src/b.rs"]);
    expect(installedDeclaredTestFiles("/repo/a")).toEqual([]);
  });
});
