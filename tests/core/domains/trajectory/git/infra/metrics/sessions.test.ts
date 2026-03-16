/**
 * Tests for squash-aware session grouping.
 *
 * Groups commits into sessions by (author, time gap).
 * When enabled, session count replaces commit count for
 * churn-related signals.
 */

import { describe, expect, it } from "vitest";

import type { CommitInfo } from "../../../../../../../src/core/adapters/git/types.js";
import {
  groupIntoSessions,
  groupTimestampsIntoSessions,
} from "../../../../../../../src/core/domains/trajectory/git/infra/metrics/sessions.js";

const BASE_TS = 1700000000; // arbitrary fixed timestamp
const HOUR = 3600;
const MIN = 60;

function commit(overrides: Partial<CommitInfo> & { timestamp: number }): CommitInfo {
  return {
    sha: `sha-${overrides.timestamp}`,
    author: "alice",
    authorEmail: "alice@x.com",
    body: "feat: something",
    ...overrides,
  };
}

describe("groupIntoSessions", () => {
  const GAP = 30; // 30 minutes default

  it("groups burst commits from same author into one session", () => {
    const commits: CommitInfo[] = [
      commit({ timestamp: BASE_TS }),
      commit({ timestamp: BASE_TS + 5 * MIN }),
      commit({ timestamp: BASE_TS + 10 * MIN }),
      commit({ timestamp: BASE_TS + 15 * MIN }),
    ];
    const sessions = groupIntoSessions(commits, GAP);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].commitCount).toBe(4);
  });

  it("splits into two sessions when gap exceeds threshold", () => {
    const commits: CommitInfo[] = [
      commit({ timestamp: BASE_TS }),
      commit({ timestamp: BASE_TS + 5 * MIN }),
      // 2-hour gap
      commit({ timestamp: BASE_TS + 2 * HOUR }),
      commit({ timestamp: BASE_TS + 2 * HOUR + 10 * MIN }),
    ];
    const sessions = groupIntoSessions(commits, GAP);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].commitCount).toBe(2);
    expect(sessions[1].commitCount).toBe(2);
  });

  it("separates sessions by author even with no time gap", () => {
    const commits: CommitInfo[] = [
      commit({ timestamp: BASE_TS, author: "alice", authorEmail: "a@x.com" }),
      commit({ timestamp: BASE_TS + 1 * MIN, author: "bob", authorEmail: "b@x.com" }),
      commit({ timestamp: BASE_TS + 2 * MIN, author: "alice", authorEmail: "a@x.com" }),
    ];
    const sessions = groupIntoSessions(commits, GAP);
    // alice: 2 commits in 2min = 1 session, bob: 1 commit = 1 session
    expect(sessions).toHaveLength(2);
  });

  it("marks session as fix if any commit is a bug fix", () => {
    const commits: CommitInfo[] = [
      commit({ timestamp: BASE_TS, body: "feat: add feature" }),
      commit({ timestamp: BASE_TS + 5 * MIN, body: "fix: broken thing" }),
      commit({ timestamp: BASE_TS + 10 * MIN, body: "chore: cleanup" }),
    ];
    const sessions = groupIntoSessions(commits, GAP);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].isFix).toBe(true);
  });

  it("marks session as non-fix when no fix commits", () => {
    const commits: CommitInfo[] = [
      commit({ timestamp: BASE_TS, body: "feat: add feature" }),
      commit({ timestamp: BASE_TS + 5 * MIN, body: "chore: cleanup" }),
    ];
    const sessions = groupIntoSessions(commits, GAP);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].isFix).toBe(false);
  });

  it("uses last commit timestamp as session timestamp", () => {
    const commits: CommitInfo[] = [
      commit({ timestamp: BASE_TS }),
      commit({ timestamp: BASE_TS + 10 * MIN }),
      commit({ timestamp: BASE_TS + 20 * MIN }),
    ];
    const sessions = groupIntoSessions(commits, GAP);
    expect(sessions[0].timestamp).toBe(BASE_TS + 20 * MIN);
  });

  it("returns empty array for empty commits", () => {
    expect(groupIntoSessions([], GAP)).toEqual([]);
  });

  it("returns one session for single commit", () => {
    const sessions = groupIntoSessions([commit({ timestamp: BASE_TS })], GAP);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].commitCount).toBe(1);
  });

  it("treats gap exactly at threshold as new session", () => {
    const commits: CommitInfo[] = [
      commit({ timestamp: BASE_TS }),
      commit({ timestamp: BASE_TS + 30 * MIN }), // exactly 30 min gap
    ];
    const sessions = groupIntoSessions(commits, GAP);
    expect(sessions).toHaveLength(2);
  });

  it("excludes merge commits from session grouping", () => {
    const commits: CommitInfo[] = [
      commit({ timestamp: BASE_TS, body: "feat: add feature" }),
      commit({ timestamp: BASE_TS + 5 * MIN, body: "Merge branch 'fix/TD-123' into main" }),
      commit({ timestamp: BASE_TS + 10 * MIN, body: "chore: cleanup" }),
    ];
    const sessions = groupIntoSessions(commits, GAP);
    // Merge commit excluded, 2 regular commits = 1 session
    expect(sessions).toHaveLength(1);
    expect(sessions[0].commitCount).toBe(2);
  });

  it("returns empty when all commits are merges", () => {
    const commits: CommitInfo[] = [
      commit({ timestamp: BASE_TS, body: "Merge branch 'feature-a' into main" }),
      commit({ timestamp: BASE_TS + 5 * MIN, body: "Merge pull request #42 from org/branch" }),
    ];
    const sessions = groupIntoSessions(commits, GAP);
    expect(sessions).toHaveLength(0);
  });

  it("handles unsorted commits correctly", () => {
    const commits: CommitInfo[] = [
      commit({ timestamp: BASE_TS + 10 * MIN }),
      commit({ timestamp: BASE_TS }),
      commit({ timestamp: BASE_TS + 2 * HOUR }),
    ];
    const sessions = groupIntoSessions(commits, GAP);
    expect(sessions).toHaveLength(2);
  });

  it("handles multi-author interleaved commits", () => {
    const commits: CommitInfo[] = [
      commit({ timestamp: BASE_TS, author: "alice", authorEmail: "a@x.com" }),
      commit({ timestamp: BASE_TS + 5 * MIN, author: "bob", authorEmail: "b@x.com" }),
      commit({ timestamp: BASE_TS + 10 * MIN, author: "alice", authorEmail: "a@x.com" }),
      // 2h gap for both
      commit({ timestamp: BASE_TS + 2 * HOUR, author: "alice", authorEmail: "a@x.com" }),
      commit({ timestamp: BASE_TS + 2 * HOUR + 5 * MIN, author: "bob", authorEmail: "b@x.com" }),
    ];
    const sessions = groupIntoSessions(commits, GAP);
    // alice: 2 sessions (BASE..+10min, then +2h), bob: 2 sessions (+5min, then +2h+5min)
    expect(sessions).toHaveLength(4);
  });

  it("preserves author on each session", () => {
    const commits: CommitInfo[] = [
      commit({ timestamp: BASE_TS, author: "alice", authorEmail: "a@x.com" }),
      commit({ timestamp: BASE_TS + 2 * HOUR, author: "bob", authorEmail: "b@x.com" }),
    ];
    const sessions = groupIntoSessions(commits, GAP);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.author).sort()).toEqual(["alice", "bob"]);
  });
});

describe("groupTimestampsIntoSessions", () => {
  const GAP = 30; // 30 minutes

  it("returns empty array for empty input", () => {
    expect(groupTimestampsIntoSessions([], [], GAP)).toEqual([]);
  });

  it("returns single timestamp for single entry", () => {
    const result = groupTimestampsIntoSessions([BASE_TS], ["alice"], GAP);
    expect(result).toEqual([BASE_TS]);
  });

  it("groups burst timestamps from same author into one session", () => {
    const timestamps = [BASE_TS, BASE_TS + 5 * MIN, BASE_TS + 10 * MIN, BASE_TS + 15 * MIN];
    const authors = ["alice", "alice", "alice", "alice"];
    const result = groupTimestampsIntoSessions(timestamps, authors, GAP);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(BASE_TS + 15 * MIN); // last timestamp
  });

  it("splits into sessions when gap exceeds threshold", () => {
    const timestamps = [BASE_TS, BASE_TS + 5 * MIN, BASE_TS + 2 * HOUR, BASE_TS + 2 * HOUR + 5 * MIN];
    const authors = ["alice", "alice", "alice", "alice"];
    const result = groupTimestampsIntoSessions(timestamps, authors, GAP);
    expect(result).toHaveLength(2);
  });

  it("separates sessions by author even with no time gap", () => {
    const timestamps = [BASE_TS, BASE_TS + 1 * MIN, BASE_TS + 2 * MIN];
    const authors = ["alice", "bob", "alice"];
    const result = groupTimestampsIntoSessions(timestamps, authors, GAP);
    // alice: 1 session (2 commits), bob: 1 session (1 commit)
    expect(result).toHaveLength(2);
  });

  it("treats gap exactly at threshold as new session", () => {
    const timestamps = [BASE_TS, BASE_TS + 30 * MIN];
    const authors = ["alice", "alice"];
    const result = groupTimestampsIntoSessions(timestamps, authors, GAP);
    expect(result).toHaveLength(2);
  });

  it("handles unsorted timestamps correctly", () => {
    const timestamps = [BASE_TS + 10 * MIN, BASE_TS, BASE_TS + 2 * HOUR];
    const authors = ["alice", "alice", "alice"];
    const result = groupTimestampsIntoSessions(timestamps, authors, GAP);
    expect(result).toHaveLength(2);
  });

  it("handles multi-author interleaved timestamps", () => {
    const timestamps = [BASE_TS, BASE_TS + 5 * MIN, BASE_TS + 2 * HOUR, BASE_TS + 2 * HOUR + 5 * MIN];
    const authors = ["alice", "bob", "alice", "bob"];
    const result = groupTimestampsIntoSessions(timestamps, authors, GAP);
    // alice: 2 sessions (BASE, +2h), bob: 2 sessions (+5min, +2h+5min)
    expect(result).toHaveLength(4);
  });

  it("falls back to 'unknown' for missing authors", () => {
    const timestamps = [BASE_TS, BASE_TS + 5 * MIN];
    const authors: string[] = []; // empty — shorter than timestamps
    const result = groupTimestampsIntoSessions(timestamps, authors, GAP);
    // Both get "unknown" author, within gap → 1 session
    expect(result).toHaveLength(1);
  });

  it("returns sorted session timestamps", () => {
    const timestamps = [BASE_TS + 2 * HOUR, BASE_TS, BASE_TS + 4 * HOUR];
    const authors = ["alice", "alice", "alice"];
    const result = groupTimestampsIntoSessions(timestamps, authors, GAP);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toBeGreaterThanOrEqual(result[i - 1]);
    }
  });
});
