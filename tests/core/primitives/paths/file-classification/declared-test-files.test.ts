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
    expect(isDeclaredTestFile("crates/searcher/src/testutil.rs", "/repo/a")).toBe(false);
    expect(classify("crates/searcher/src/testutil.rs", { projectRoot: "/repo/a" }).isTest).toBe(false);
  });

  it("raises isTest for a path the caller's project declared, keeping it source", () => {
    installDeclaredTestFiles("/repo/a", ["crates/searcher/src/testutil.rs"]);
    const classification = classify("crates/searcher/src/testutil.rs", { projectRoot: "/repo/a" });
    expect(classification.isTest).toBe(true);
    expect(classification.isSource).toBe(true);
    expect(classify("crates/searcher/src/searcher.rs", { projectRoot: "/repo/a" }).isTest).toBe(false);
    // The conventions answer stays the conventions'.
    expect(matchesTestFileConventions("crates/searcher/src/testutil.rs")).toBe(false);
  });

  it("keys the set by project root — the same relative path is test in A and production in B", () => {
    installDeclaredTestFiles("/repo/a", ["src/test_utils.rs"]);
    installDeclaredTestFiles("/repo/b", ["src/b.rs"]);

    expect(classify("src/test_utils.rs", { projectRoot: "/repo/a" }).isTest).toBe(true);
    expect(classify("src/test_utils.rs", { projectRoot: "/repo/b" }).isTest).toBe(false);
    expect(classify("src/b.rs", { projectRoot: "/repo/b" }).isTest).toBe(true);
    expect(classify("src/b.rs", { projectRoot: "/repo/a" }).isTest).toBe(false);
    expect(installedDeclaredTestFiles("/repo/a")).toEqual(["src/test_utils.rs"]);
    expect(installedDeclaredTestFiles("/repo/b")).toEqual(["src/b.rs"]);
  });

  it("ignores every declared set when the caller names no project root", () => {
    installDeclaredTestFiles("/repo/a", ["src/test_utils.rs"]);
    expect(classify("src/test_utils.rs").isTest).toBe(false);
    expect(classify("src/test_utils.rs", { isDocumentation: false }).isTest).toBe(false);
  });

  it("replaces one root's set without touching another's", () => {
    installDeclaredTestFiles("/repo/a", ["src/a.rs"]);
    installDeclaredTestFiles("/repo/b", ["src/b.rs"]);
    installDeclaredTestFiles("/repo/b", []);
    expect(isDeclaredTestFile("src/a.rs", "/repo/a")).toBe(true);
    expect(isDeclaredTestFile("src/b.rs", "/repo/b")).toBe(false);
    expect(installedDeclaredTestFiles("/repo/b")).toEqual([]);
  });

  it("normalizes the root, so a trailing slash or a dot segment names the same project", () => {
    installDeclaredTestFiles("/repo/a/", ["src/a.rs"]);
    expect(isDeclaredTestFile("src/a.rs", "/repo/a")).toBe(true);
    expect(isDeclaredTestFile("src/a.rs", "/repo/./a")).toBe(true);
    expect(installedDeclaredTestFiles("/repo/a")).toEqual(["src/a.rs"]);
  });
});
