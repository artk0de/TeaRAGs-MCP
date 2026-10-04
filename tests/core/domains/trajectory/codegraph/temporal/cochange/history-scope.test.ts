/**
 * Scoping repo history to the project's file space (bd tea-rags-mcp-x4rpp).
 *
 * Invariants under test:
 *   - a path is attributed to its HEAD name across renames (the chunk walk's
 *     own rename following), so a file's history does not split at a rename;
 *   - a project indexed from a repo SUBDIRECTORY sees only its own files, as
 *     project-relative paths;
 *   - a file absent from the working tree is dropped — its pairs describe code
 *     that no longer exists;
 *   - merge commits are dropped, and a commit left with no file vanishes.
 */

import { describe, expect, it } from "vitest";

import type { CommitInfo } from "../../../../../../../src/core/adapters/vcs/types.js";
import { scopeCochangeHistory } from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";
import type { GitCommitDiscoveryEntry } from "../../../../../../../src/core/domains/trajectory/git/infra/commit-discovery.js";

function entry(
  sha: string,
  changed: { path: string; previousPath?: string }[],
  body = "feat: x",
  timestamp = 100,
): GitCommitDiscoveryEntry {
  const commit: CommitInfo = { sha, author: "alice", authorEmail: "a@x", timestamp, body, parents: [] };
  return { commit, changedFiles: changed };
}

describe("scopeCochangeHistory", () => {
  it("attributes pre-rename commits to the HEAD path", () => {
    const entries = [
      entry("s2", [{ path: "src/new.ts", previousPath: "src/old.ts" }]),
      entry("s1", [{ path: "src/old.ts" }, { path: "src/other.ts" }]),
    ];

    const scoped = scopeCochangeHistory(entries, { projectPrefix: "", fileExists: () => true });

    expect(scoped.map((c) => [c.commit.sha, c.files])).toEqual([
      ["s2", ["src/new.ts"]],
      ["s1", ["src/new.ts", "src/other.ts"]],
    ]);
  });

  it("keeps only the project's subtree, as project-relative paths", () => {
    const scoped = scopeCochangeHistory([entry("s1", [{ path: "app/a.ts" }, { path: "infra/x.tf" }])], {
      projectPrefix: "app/",
      fileExists: () => true,
    });

    expect(scoped.map((c) => c.files)).toEqual([["a.ts"]]);
  });

  it("drops files missing from the working tree and commits left empty", () => {
    const scoped = scopeCochangeHistory(
      [entry("s2", [{ path: "gone.ts" }]), entry("s1", [{ path: "gone.ts" }, { path: "kept.ts" }])],
      { projectPrefix: "", fileExists: (p) => p !== "gone.ts" },
    );

    expect(scoped.map((c) => [c.commit.sha, c.files])).toEqual([["s1", ["kept.ts"]]]);
  });

  it("drops merge commits", () => {
    const entries = [
      {
        commit: {
          sha: "m",
          author: "alice",
          authorEmail: "a@x",
          timestamp: 100,
          body: "Merge branch 'x'",
          parents: ["p1", "p2"],
        },
        changedFiles: [{ path: "a.ts" }, { path: "b.ts" }],
      },
      entry("s", [{ path: "a.ts" }]),
    ];
    const scoped = scopeCochangeHistory(entries, { projectPrefix: "", fileExists: () => true });

    expect(scoped.map((c) => c.commit.sha)).toEqual(["s"]);
  });

  it("keeps a grafted shallow clone's root commit whose subject says Merge (bd tea-rags-mcp-12x1y)", () => {
    // A shallow clone's only commit is a grafted root: no parents, the WHOLE
    // tree as its numstat — and quite possibly a "Merge branch ..." subject,
    // which is history, not a restatement to drop.
    const grafted = entry(
      "graft",
      Array.from({ length: 3 }, (_, i) => ({ path: `src/f${i}.ts` })),
      "Merge branch 'master' of https://example.com/repo.git",
    );
    const scoped = scopeCochangeHistory([grafted, entry("s", [{ path: "src/f0.ts" }])], {
      projectPrefix: "",
      fileExists: () => true,
    });

    expect(scoped.map((c) => [c.commit.sha, c.files])).toEqual([
      ["graft", ["src/f0.ts", "src/f1.ts", "src/f2.ts"]],
      ["s", ["src/f0.ts"]],
    ]);
  });

  it("lists each file once per commit", () => {
    const scoped = scopeCochangeHistory([entry("s", [{ path: "a.ts" }, { path: "a.ts" }])], {
      projectPrefix: "",
      fileExists: () => true,
    });

    expect(scoped[0].files).toEqual(["a.ts"]);
  });
});
