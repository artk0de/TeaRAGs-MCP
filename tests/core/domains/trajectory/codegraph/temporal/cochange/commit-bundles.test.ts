/**
 * Commit bundling for the co-change extractor (bd tea-rags-mcp-x4rpp, spec open
 * question 4): one bundle per commit, or — when squash-aware sessions are on —
 * one per author session, by the git trajectory's own grouping rule.
 */

import { describe, expect, it } from "vitest";

import type { CommitInfo } from "../../../../../../../src/core/adapters/vcs/types.js";
import {
  bundleCochangeCommits,
  type CochangeCommit,
} from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

const MIN = 60;

function commit(sha: string, author: string, timestamp: number, files: string[]): CochangeCommit {
  const info: CommitInfo = { sha, author, authorEmail: `${author}@x`, timestamp, body: "feat: x", parents: [] };
  return { commit: info, files };
}

describe("bundleCochangeCommits", () => {
  it("makes one bundle per commit when session bundling is off", () => {
    const bundles = bundleCochangeCommits(
      [commit("b", "alice", 2 * MIN, ["b.ts"]), commit("a", "alice", MIN, ["a.ts", "b.ts"])],
      null,
    );

    expect(bundles).toEqual([
      { shas: ["a"], timestamp: MIN, files: ["a.ts", "b.ts"] },
      { shas: ["b"], timestamp: 2 * MIN, files: ["b.ts"] },
    ]);
  });

  it("unions a same-author session into one bundle, members oldest first", () => {
    const bundles = bundleCochangeCommits(
      [
        commit("a2", "alice", 10 * MIN, ["c.yml", "a.ts"]),
        commit("a1", "alice", 0, ["a.ts"]),
        commit("b1", "bob", 5 * MIN, ["b.ts"]),
        commit("a3", "alice", 100 * MIN, ["d.ts"]),
      ],
      30,
    );

    expect(bundles).toEqual([
      { shas: ["b1"], timestamp: 5 * MIN, files: ["b.ts"] },
      { shas: ["a1", "a2"], timestamp: 10 * MIN, files: ["a.ts", "c.yml"] },
      { shas: ["a3"], timestamp: 100 * MIN, files: ["d.ts"] },
    ]);
  });
});
