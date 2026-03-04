/**
 * Tests for squash-aware session normalization in assemblers.
 *
 * When squashAwareSessions is enabled, commit-count-dependent metrics
 * use session count instead of raw commit count.
 */

import { describe, expect, it } from "vitest";

import type { FileChurnData } from "../../../../../../src/core/adapters/git/types.js";
import type { ChunkAccumulator } from "../../../../../../src/core/trajectory/git/infra/metrics.js";
import { assembleChunkSignals } from "../../../../../../src/core/trajectory/git/infra/metrics/chunk-assembler.js";
import { assembleFileSignals } from "../../../../../../src/core/trajectory/git/infra/metrics/file-assembler.js";

const BASE_TS = 1700000000;
const MIN = 60;
const HOUR = 3600;

/** Options to enable squash-aware sessions */
const SQUASH_OPTS = { squashAwareSessions: true, sessionGapMinutes: 30 };

describe("assembleFileSignals with squash-aware sessions", () => {
  it("uses session count as commitCount when squash enabled", () => {
    // 5 burst commits within 15 minutes = 1 session
    const churnData: FileChurnData = {
      commits: [
        { sha: "a1", author: "alice", authorEmail: "a@x.com", timestamp: BASE_TS, body: "feat: step 1" },
        { sha: "a2", author: "alice", authorEmail: "a@x.com", timestamp: BASE_TS + 3 * MIN, body: "feat: step 2" },
        { sha: "a3", author: "alice", authorEmail: "a@x.com", timestamp: BASE_TS + 6 * MIN, body: "feat: step 3" },
        { sha: "a4", author: "alice", authorEmail: "a@x.com", timestamp: BASE_TS + 9 * MIN, body: "feat: step 4" },
        { sha: "a5", author: "alice", authorEmail: "a@x.com", timestamp: BASE_TS + 12 * MIN, body: "feat: step 5" },
      ],
      linesAdded: 200,
      linesDeleted: 50,
    };

    const withSquash = assembleFileSignals(churnData, 300, SQUASH_OPTS);
    const without = assembleFileSignals(churnData, 300);

    expect(without.commitCount).toBe(5);
    expect(withSquash.commitCount).toBe(1); // 1 session
  });

  it("uses session-based bugFixRate when squash enabled", () => {
    // Session 1: feat commits (not fix)
    // Session 2: fix commit (2h later)
    const churnData: FileChurnData = {
      commits: [
        { sha: "a1", author: "alice", authorEmail: "a@x.com", timestamp: BASE_TS, body: "feat: add feature" },
        { sha: "a2", author: "alice", authorEmail: "a@x.com", timestamp: BASE_TS + 5 * MIN, body: "feat: more" },
        {
          sha: "a3",
          author: "alice",
          authorEmail: "a@x.com",
          timestamp: BASE_TS + 2 * HOUR,
          body: "fix: broken thing",
        },
      ],
      linesAdded: 100,
      linesDeleted: 20,
    };

    const withSquash = assembleFileSignals(churnData, 200, SQUASH_OPTS);
    // 2 sessions, 1 fix session → Laplace: (1 + 0.5) / (2 + 1.0) = 0.5 → 50%
    expect(withSquash.bugFixRate).toBe(50);
  });

  it("uses session-based changeDensity when squash enabled", () => {
    // 10 commits in 2 hours, but only 2 sessions
    const commits = [];
    for (let i = 0; i < 5; i++) {
      commits.push({
        sha: `a${i}`,
        author: "alice",
        authorEmail: "a@x.com",
        timestamp: BASE_TS + i * 5 * MIN,
        body: "feat: burst 1",
      });
    }
    for (let i = 0; i < 5; i++) {
      commits.push({
        sha: `b${i}`,
        author: "alice",
        authorEmail: "a@x.com",
        timestamp: BASE_TS + 2 * HOUR + i * 5 * MIN,
        body: "feat: burst 2",
      });
    }

    const churnData: FileChurnData = { commits, linesAdded: 100, linesDeleted: 50 };

    const withSquash = assembleFileSignals(churnData, 200, SQUASH_OPTS);
    const without = assembleFileSignals(churnData, 200);

    // Without: 10 commits / span → high density
    // With: 2 sessions / span → lower density
    expect(withSquash.changeDensity).toBeLessThan(without.changeDensity);
  });

  it("does not affect line-based metrics when squash enabled", () => {
    const churnData: FileChurnData = {
      commits: [
        { sha: "a1", author: "alice", authorEmail: "a@x.com", timestamp: BASE_TS, body: "feat: step 1" },
        { sha: "a2", author: "alice", authorEmail: "a@x.com", timestamp: BASE_TS + 5 * MIN, body: "feat: step 2" },
      ],
      linesAdded: 200,
      linesDeleted: 50,
    };

    const withSquash = assembleFileSignals(churnData, 300, SQUASH_OPTS);
    const without = assembleFileSignals(churnData, 300);

    // Line-based metrics unchanged
    expect(withSquash.linesAdded).toBe(without.linesAdded);
    expect(withSquash.linesDeleted).toBe(without.linesDeleted);
    expect(withSquash.relativeChurn).toBe(without.relativeChurn);
    // Authorship unchanged
    expect(withSquash.dominantAuthor).toBe(without.dominantAuthor);
    expect(withSquash.authors).toEqual(without.authors);
    expect(withSquash.contributorCount).toBe(without.contributorCount);
    // Temporal unchanged
    expect(withSquash.ageDays).toBe(without.ageDays);
  });

  it("returns regular commitCount when squash disabled", () => {
    const churnData: FileChurnData = {
      commits: [
        { sha: "a1", author: "alice", authorEmail: "a@x.com", timestamp: BASE_TS, body: "feat: a" },
        { sha: "a2", author: "alice", authorEmail: "a@x.com", timestamp: BASE_TS + 5 * MIN, body: "feat: b" },
      ],
      linesAdded: 10,
      linesDeleted: 5,
    };

    const result = assembleFileSignals(churnData, 100);
    expect(result.commitCount).toBe(2); // raw count
  });
});

describe("assembleChunkSignals with squash-aware sessions", () => {
  it("uses session count for chunk commitCount when squash enabled", () => {
    // 4 chunk commits in burst = 1 session
    const acc: ChunkAccumulator = {
      commitShas: new Set(["a1", "a2", "a3", "a4"]),
      authors: new Set(["alice"]),
      bugFixCount: 0,
      lastModifiedAt: BASE_TS + 15 * MIN,
      linesAdded: 40,
      linesDeleted: 10,
      commitTimestamps: [BASE_TS, BASE_TS + 5 * MIN, BASE_TS + 10 * MIN, BASE_TS + 15 * MIN],
      commitAuthors: ["alice", "alice", "alice", "alice"],
      taskIds: new Set(),
    };

    const withSquash = assembleChunkSignals(acc, 10, undefined, 50, SQUASH_OPTS);
    const without = assembleChunkSignals(acc, 10, undefined, 50);

    expect(without.commitCount).toBe(4);
    expect(withSquash.commitCount).toBe(1); // 1 session
  });

  it("uses session count for chunk churnRatio when squash enabled", () => {
    const acc: ChunkAccumulator = {
      commitShas: new Set(["a1", "a2", "a3", "a4"]),
      authors: new Set(["alice"]),
      bugFixCount: 0,
      lastModifiedAt: BASE_TS + 15 * MIN,
      linesAdded: 40,
      linesDeleted: 10,
      commitTimestamps: [BASE_TS, BASE_TS + 5 * MIN, BASE_TS + 10 * MIN, BASE_TS + 15 * MIN],
      commitAuthors: ["alice", "alice", "alice", "alice"],
      taskIds: new Set(),
    };

    // fileCommitCount also session-based = 2 sessions
    const withSquash = assembleChunkSignals(acc, 2, undefined, 50, SQUASH_OPTS);
    // chunk: 1 session / file: 2 sessions = 0.5
    expect(withSquash.churnRatio).toBe(0.5);
  });

  it("separates chunk sessions by author", () => {
    const acc: ChunkAccumulator = {
      commitShas: new Set(["a1", "a2", "b1", "b2"]),
      authors: new Set(["alice", "bob"]),
      bugFixCount: 0,
      lastModifiedAt: BASE_TS + 15 * MIN,
      linesAdded: 40,
      linesDeleted: 10,
      commitTimestamps: [BASE_TS, BASE_TS + 5 * MIN, BASE_TS + 2 * MIN, BASE_TS + 7 * MIN],
      commitAuthors: ["alice", "alice", "bob", "bob"],
      taskIds: new Set(),
    };

    const withSquash = assembleChunkSignals(acc, 10, undefined, 50, SQUASH_OPTS);
    // alice: 1 session, bob: 1 session = 2 sessions total
    expect(withSquash.commitCount).toBe(2);
  });
});
