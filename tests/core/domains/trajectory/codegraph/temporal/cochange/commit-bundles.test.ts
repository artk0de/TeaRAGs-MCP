/**
 * Commit bundling for the co-change extractor (bd tea-rags-mcp-x4rpp; burst
 * rule bd tea-rags-mcp-3vg0x): one bundle per commit, each tagged with its
 * author burst — the maximal run of one author identity's commits whose
 * consecutive gaps stay under the window — so the extractor counts a file or a
 * pair at most once per burst without ever unioning two commits' files.
 */

import { describe, expect, it } from "vitest";

import type { CommitInfo } from "../../../../../../../src/core/adapters/vcs/types.js";
import {
  bundleCochangeCommits,
  type CochangeCommit,
} from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

const MIN = 60;

function commit(
  sha: string,
  author: string,
  timestamp: number,
  files: string[],
  email = `${author}@x`,
): CochangeCommit {
  const info: CommitInfo = { sha, author, authorEmail: email, timestamp, body: "feat: x", parents: [] };
  return { commit: info, files };
}

describe("bundleCochangeCommits", () => {
  it("makes one bundle per commit, oldest first, each carrying only its own sha and files", () => {
    const bundles = bundleCochangeCommits(
      [commit("b", "alice", 2 * MIN, ["b.ts"]), commit("a", "alice", MIN, ["b.ts", "a.ts"])],
      30,
    );

    expect(bundles.map(({ shas, timestamp, files }) => ({ shas, timestamp, files }))).toEqual([
      { shas: ["a"], timestamp: MIN, files: ["a.ts", "b.ts"] },
      { shas: ["b"], timestamp: 2 * MIN, files: ["b.ts"] },
    ]);
  });

  it("tags a same-author run with consecutive gaps under the window as one burst, never unioning its files", () => {
    const bundles = bundleCochangeCommits(
      [
        commit("a2", "alice", 10 * MIN, ["c.yml", "a.ts"]),
        commit("a1", "alice", 0, ["a.ts"]),
        commit("b1", "bob", 5 * MIN, ["b.ts"]),
        commit("a3", "alice", 100 * MIN, ["d.ts"]),
      ],
      30,
    );

    const bySha = new Map(bundles.map((b) => [b.shas[0], b]));
    expect(bundles.map((b) => b.shas[0])).toEqual(["a1", "b1", "a2", "a3"]);
    expect(bySha.get("a1")?.files).toEqual(["a.ts"]);
    expect(bySha.get("a2")?.files).toEqual(["a.ts", "c.yml"]);
    expect(bySha.get("a1")?.burst).toBe(bySha.get("a2")?.burst);
    expect(bySha.get("b1")?.burst).not.toBe(bySha.get("a1")?.burst);
    expect(bySha.get("a3")?.burst).not.toBe(bySha.get("a1")?.burst);
  });

  it("chains a burst through consecutive gaps, so its span may exceed the window", () => {
    const bundles = bundleCochangeCommits(
      [0, 20, 40, 60, 80].map((m, i) => commit(`a${i}`, "alice", m * MIN, ["x.ts", "y.ts"])),
      30,
    );

    expect(new Set(bundles.map((b) => b.burst)).size).toBe(1);
  });

  it("forms one burst from two display names sharing an email", () => {
    const bundles = bundleCochangeCommits(
      [
        commit("n1", "artk0de", 0, ["x.ts", "y.ts"], "art@x"),
        commit("n2", "Arthur Korochansky", 10 * MIN, ["x.ts", "y.ts"], "Art@X"),
      ],
      30,
    );

    expect(bundles[0].burst).toBe(bundles[1].burst);
  });

  it("carries each commit's per-file line counts onto its bundle (bd tea-rags-mcp-dm61n)", () => {
    const counted: CochangeCommit = {
      ...commit("a", "alice", 0, ["b.ts", "a.ts"]),
      fileLines: new Map([["a.ts", { added: 2, deleted: 1 }]]),
    };
    const bundles = bundleCochangeCommits([counted, commit("b", "alice", MIN, ["b.ts"])], 30);

    expect(bundles.map((b) => b.fileLines)).toEqual([new Map([["a.ts", { added: 2, deleted: 1 }]]), undefined]);
  });

  it("carries the task ids the git trajectory reads from each commit's message", () => {
    const tagged = commit("a", "alice", 0, ["a.ts"]);
    tagged.commit.body = "fix(api): TD-1234 keep the SHA-256 cursor (#567)";
    // bd tea-rags-mcp-8rcox: ids are read under the run's learned vocabulary.
    const vocabulary = { projectKeys: new Set(["TD"]), forgeIssueRefs: true };
    const bundles = bundleCochangeCommits([tagged, commit("b", "alice", MIN, ["b.ts"])], 30, vocabulary);

    expect(bundles.map((b) => b.taskIds)).toEqual([["TD-1234", "#567"], []]);
  });
});
