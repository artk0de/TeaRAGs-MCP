/**
 * The repository-derived burst window W (bd tea-rags-mcp-3vg0x): the gap at
 * which the EXCESS file-set overlap between consecutive same-author commits
 * (mean Jaccard minus the overlap of same-author commits a week or more apart)
 * has fallen to half its value at gaps under 15 minutes.
 *
 * Synthetic histories: isolated commit PAIRS, each pair a week and a day from
 * the next, every pair on its own files. A pair's two commits are either the
 * same file set (Jaccard 1) or disjoint (Jaccard 0), so a gap bin's mean
 * Jaccard is exactly the share of identical pairs in it, and the baseline —
 * commits a week or more apart never share a file — is 0.
 */

import { describe, expect, it } from "vitest";

import type { CommitInfo } from "../../../../../../../src/core/adapters/vcs/types.js";
import {
  BURST_WINDOW_FALLBACK_MINUTES,
  BURST_WINDOW_MAX_MINUTES,
  BURST_WINDOW_MIN_MINUTES,
  estimateBurstWindow,
  type CochangeCommit,
} from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

const MIN = 60;
const PAIR_SPACING = 8 * 24 * 60 * MIN;

function commit(sha: string, timestamp: number, files: string[], author = "alice"): CochangeCommit {
  const info: CommitInfo = { sha, author, authorEmail: `${author}@x`, timestamp, body: "feat: x", parents: [] };
  return { commit: info, files };
}

/** `count` commit pairs `gapMinutes` apart, the first `identical` of them on the same two files. */
function history(bins: { gapMinutes: number; count: number; identical: number }[]): CochangeCommit[] {
  const commits: CochangeCommit[] = [];
  let pair = 0;
  for (const { gapMinutes, count, identical } of bins) {
    for (let i = 0; i < count; i++, pair++) {
      const start = pair * PAIR_SPACING;
      const first = [`p${pair}/a.ts`, `p${pair}/b.ts`];
      const second = i < identical ? first : [`p${pair}/c.ts`, `p${pair}/d.ts`];
      commits.push(commit(`s${pair}a`, start, first), commit(`s${pair}b`, start + gapMinutes * MIN, second));
    }
  }
  return commits;
}

describe("estimateBurstWindow", () => {
  it("returns the upper edge of the first gap bin whose excess overlap fell to half the head's", () => {
    // Head (5 min) excess 0.8 → half 0.4; [30,45) 0.6, [90,120) 0.5 stay above; [120,180) 0.3 crosses.
    const commits = history([
      { gapMinutes: 5, count: 40, identical: 32 },
      { gapMinutes: 40, count: 40, identical: 24 },
      { gapMinutes: 100, count: 40, identical: 20 },
      { gapMinutes: 150, count: 40, identical: 12 },
      { gapMinutes: 300, count: 40, identical: 4 },
    ]);

    expect(estimateBurstWindow(commits)).toEqual({ minutes: 180, method: "estimated" });
  });

  it("skips a gap bin too thin for a stable mean instead of reading it as the crossing", () => {
    const commits = history([
      { gapMinutes: 5, count: 40, identical: 32 },
      { gapMinutes: 40, count: 5, identical: 0 },
      { gapMinutes: 150, count: 40, identical: 12 },
    ]);

    expect(estimateBurstWindow(commits)).toEqual({ minutes: 180, method: "estimated" });
  });

  it("clamps a decay faster than the lower bound up to it", () => {
    const commits = history([
      { gapMinutes: 5, count: 40, identical: 32 },
      { gapMinutes: 17, count: 40, identical: 4 },
    ]);

    expect(estimateBurstWindow(commits)).toEqual({ minutes: BURST_WINDOW_MIN_MINUTES, method: "estimated" });
  });

  it("clamps to the upper bound when the excess never halves inside it", () => {
    const commits = history([
      { gapMinutes: 5, count: 40, identical: 32 },
      { gapMinutes: 60, count: 40, identical: 32 },
      { gapMinutes: 600, count: 40, identical: 30 },
    ]);

    expect(estimateBurstWindow(commits)).toEqual({ minutes: BURST_WINDOW_MAX_MINUTES, method: "estimated" });
  });

  it("falls back when the history has too few consecutive same-author pairs", () => {
    const commits = history([
      { gapMinutes: 5, count: 6, identical: 6 },
      { gapMinutes: 150, count: 6, identical: 0 },
    ]);

    expect(estimateBurstWindow(commits)).toEqual({ minutes: BURST_WINDOW_FALLBACK_MINUTES, method: "fallback" });
    expect(estimateBurstWindow([])).toEqual({ minutes: BURST_WINDOW_FALLBACK_MINUTES, method: "fallback" });
  });

  it("falls back when no gap bin past the head holds enough pairs to show the decay", () => {
    const commits = history([
      { gapMinutes: 5, count: 40, identical: 32 },
      { gapMinutes: 150, count: 10, identical: 0 },
    ]);

    expect(estimateBurstWindow(commits)).toEqual({ minutes: BURST_WINDOW_FALLBACK_MINUTES, method: "fallback" });
  });

  it("falls back when consecutive commits overlap no more than distant ones", () => {
    const commits = history([
      { gapMinutes: 5, count: 40, identical: 0 },
      { gapMinutes: 150, count: 40, identical: 0 },
    ]);

    expect(estimateBurstWindow(commits)).toEqual({ minutes: BURST_WINDOW_FALLBACK_MINUTES, method: "fallback" });
  });

  it("pairs consecutive commits by author identity, not by display name", () => {
    // Each pair's second commit is under another NAME but the same email: still one author's consecutive pair.
    const commits = history([
      { gapMinutes: 5, count: 40, identical: 32 },
      { gapMinutes: 150, count: 40, identical: 12 },
    ]).map((c, i) =>
      i % 2 === 1 ? { ...c, commit: { ...c.commit, author: "Alice Example", authorEmail: "ALICE@x" } } : c,
    );

    expect(estimateBurstWindow(commits)).toEqual({ minutes: 180, method: "estimated" });
  });
});
