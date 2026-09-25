/**
 * `partitionIntoAuthorSessions` — the member-preserving form of the squash-aware
 * session grouping (bd tea-rags-mcp-x4rpp). `groupIntoSessions` reduces each
 * session to counts; the co-change extractor needs the members themselves to
 * union their changed files into one bundle, so the grouping rule lives in ONE
 * function both read.
 */

import { describe, expect, it } from "vitest";

import type { CommitInfo } from "../../../../../../../src/core/adapters/vcs/types.js";
import {
  groupIntoSessions,
  partitionIntoAuthorSessions,
} from "../../../../../../../src/core/domains/trajectory/git/infra/metrics/sessions.js";

const BASE_TS = 1_700_000_000;
const MIN = 60;

function commit(sha: string, author: string, timestamp: number): CommitInfo {
  return { sha, author, authorEmail: `${author}@x.com`, timestamp, body: "feat: x", parents: [] };
}

interface Row {
  id: string;
  commit: CommitInfo;
}

function row(id: string, author: string, timestamp: number): Row {
  return { id, commit: commit(id, author, timestamp) };
}

describe("partitionIntoAuthorSessions", () => {
  it("keeps every member of a same-author burst in one session, oldest first", () => {
    const rows = [
      row("c", "alice", BASE_TS + 20 * MIN),
      row("a", "alice", BASE_TS),
      row("b", "alice", BASE_TS + 10 * MIN),
    ];

    const sessions = partitionIntoAuthorSessions(rows, (r) => r.commit, 30);

    expect(sessions.map((s) => s.map((r) => r.id))).toEqual([["a", "b", "c"]]);
  });

  it("splits at a gap of at least gapMinutes and never mixes authors", () => {
    const rows = [
      row("a1", "alice", BASE_TS),
      row("b1", "bob", BASE_TS + 5 * MIN),
      row("a2", "alice", BASE_TS + 30 * MIN),
      row("a3", "alice", BASE_TS + 40 * MIN),
    ];

    const sessions = partitionIntoAuthorSessions(rows, (r) => r.commit, 30);

    expect(sessions.map((s) => s.map((r) => r.id))).toEqual([["a1"], ["b1"], ["a2", "a3"]]);
  });

  it("orders sessions by their last member's timestamp", () => {
    const rows = [row("late", "bob", BASE_TS + 100 * MIN), row("early", "alice", BASE_TS)];

    const sessions = partitionIntoAuthorSessions(rows, (r) => r.commit, 30);

    expect(sessions.map((s) => s[0].id)).toEqual(["early", "late"]);
  });

  it("returns nothing for no input", () => {
    expect(partitionIntoAuthorSessions([], (r: Row) => r.commit, 30)).toEqual([]);
  });

  it("agrees with groupIntoSessions on session count, author and last timestamp", () => {
    const commits: CommitInfo[] = [
      commit("1", "alice", BASE_TS),
      commit("2", "alice", BASE_TS + 10 * MIN),
      commit("3", "bob", BASE_TS + 11 * MIN),
      commit("4", "alice", BASE_TS + 90 * MIN),
    ];

    const partitioned = partitionIntoAuthorSessions(commits, (c) => c, 30);
    const grouped = groupIntoSessions(commits, 30);

    expect(
      partitioned.map((s) => ({ author: s[0].author, timestamp: s[s.length - 1].timestamp, commitCount: s.length })),
    ).toEqual(grouped.map(({ author, timestamp, commitCount }) => ({ author, timestamp, commitCount })));
  });
});
