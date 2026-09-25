/**
 * The forced work set of a scoped `--force` (bd tea-rags-mcp-j4oww): which
 * indexed files a selector re-chunks. Each filter must answer by the same
 * predicate its search namesake does, so a scoped run re-chunks exactly the
 * files a search with that filter would return.
 */

import { describe, expect, it } from "vitest";

import {
  compileRechunkFileSelector,
  selectRechunkWorkSet,
} from "../../../../../src/core/domains/ingest/operations/rechunk-work-set.js";

const FILES = [
  "src/app/user.rb",
  "spec/models/user_spec.rb",
  "spec/support/helpers.rb",
  "src/web/app.ts",
  "src/web/app.test.ts",
  "tests/core/foo.test.ts",
  "docs/readme.md",
  ".github/workflows/ci.ts",
];

function select(selector: Parameters<typeof compileRechunkFileSelector>[0]): string[] {
  const matches = compileRechunkFileSelector(selector);
  return FILES.filter(matches);
}

describe("compileRechunkFileSelector", () => {
  it("testFile only selects what the isTest classifier calls a test, support files under a test root included", () => {
    expect(select({ testFile: "only" })).toEqual([
      "spec/models/user_spec.rb",
      "spec/support/helpers.rb",
      "src/web/app.test.ts",
      "tests/core/foo.test.ts",
    ]);
  });

  it("testFile exclude selects the complement", () => {
    expect(select({ testFile: "exclude" })).toEqual([
      "src/app/user.rb",
      "src/web/app.ts",
      "docs/readme.md",
      ".github/workflows/ci.ts",
    ]);
  });

  it("languages select by the extension map, case-insensitively", () => {
    expect(select({ languages: ["Ruby"] })).toEqual([
      "src/app/user.rb",
      "spec/models/user_spec.rb",
      "spec/support/helpers.rb",
    ]);
  });

  it("pathPattern is picomatch with dot directories and whole-pattern negation", () => {
    expect(select({ pathPattern: "**/*.ts" })).toEqual([
      "src/web/app.ts",
      "src/web/app.test.ts",
      "tests/core/foo.test.ts",
      ".github/workflows/ci.ts",
    ]);
    expect(select({ pathPattern: "!src/**" })).toEqual([
      "spec/models/user_spec.rb",
      "spec/support/helpers.rb",
      "tests/core/foo.test.ts",
      "docs/readme.md",
      ".github/workflows/ci.ts",
    ]);
  });

  it("fileExtensions accept the extension with or without its dot", () => {
    expect(select({ fileExtensions: ["md", ".rb"] })).toEqual([
      "src/app/user.rb",
      "spec/models/user_spec.rb",
      "spec/support/helpers.rb",
      "docs/readme.md",
    ]);
  });

  it("files select exact project-relative paths, a leading ./ tolerated", () => {
    expect(select({ files: ["./src/web/app.ts", "docs/readme.md", "missing.rb"] })).toEqual([
      "src/web/app.ts",
      "docs/readme.md",
    ]);
  });

  it("filters combine as a conjunction", () => {
    expect(select({ testFile: "only", languages: ["typescript"] })).toEqual([
      "src/web/app.test.ts",
      "tests/core/foo.test.ts",
    ]);
  });

  it("an empty selector selects every file", () => {
    expect(select({})).toEqual(FILES);
  });
});

describe("selectRechunkWorkSet", () => {
  it("keeps only files the index already holds, and skips paths the run re-chunks anyway", () => {
    const workSet = selectRechunkWorkSet({
      selector: { testFile: "only" },
      scannedFiles: ["spec/a_spec.rb", "spec/b_spec.rb", "spec/new_spec.rb", "lib/a.rb"],
      indexedFiles: new Set(["spec/a_spec.rb", "spec/b_spec.rb", "lib/a.rb"]),
    });
    expect(workSet).toEqual(["spec/a_spec.rb", "spec/b_spec.rb"]);
  });
});
