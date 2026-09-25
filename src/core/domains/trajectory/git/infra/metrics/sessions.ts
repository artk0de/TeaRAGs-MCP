/**
 * Squash-aware session grouping for git commits.
 *
 * Groups commits into sessions by (author, time gap).
 * When enabled via config, session count replaces commit count
 * in churn-related signals, reducing noise from agent-style
 * burst commits.
 */

import type { CommitInfo } from "../../../../../adapters/vcs/types.js";
import { isBugFixCommit, MERGE_SUBJECT } from "../utils.js";

export interface Session {
  author: string;
  timestamp: number; // last commit timestamp in session
  commitCount: number;
  isFix: boolean;
}

/**
 * Partition items into sessions by (author, time gap), keeping every member.
 *
 * The ONE grouping rule behind squash-aware sessions: `groupIntoSessions`
 * reduces each partition to counts, and the co-change extractor
 * (`trajectory/codegraph/temporal`) unions the members' changed files into one
 * bundle. Members are ordered oldest first; sessions by their last member's
 * timestamp ascending (stable, so equal timestamps keep author-first-seen order).
 * No merge filtering here — callers decide what a session may contain.
 *
 * @param items - Anything carrying a commit (any order)
 * @param commitOf - Reads the commit an item stands for
 * @param gapMinutes - Silence threshold; gap >= this starts a new session
 */
export function partitionIntoAuthorSessions<T>(
  items: readonly T[],
  commitOf: (item: T) => CommitInfo,
  gapMinutes: number,
): T[][] {
  const byAuthor = new Map<string, T[]>();
  for (const item of items) {
    const { author } = commitOf(item);
    const list = byAuthor.get(author);
    if (list) {
      list.push(item);
    } else {
      byAuthor.set(author, [item]);
    }
  }

  const gapSec = gapMinutes * 60;
  const sessions: T[][] = [];
  byAuthor.forEach((authorItems) => {
    authorItems.sort((a, b) => commitOf(a).timestamp - commitOf(b).timestamp);
    let sessionStart = 0;
    for (let i = 1; i <= authorItems.length; i++) {
      const isEnd = i === authorItems.length;
      const gap = isEnd ? Infinity : commitOf(authorItems[i]).timestamp - commitOf(authorItems[i - 1]).timestamp;
      if (gap >= gapSec || isEnd) {
        sessions.push(authorItems.slice(sessionStart, i));
        sessionStart = i;
      }
    }
  });

  const lastTimestamp = (session: T[]): number => commitOf(session[session.length - 1]).timestamp;
  sessions.sort((a, b) => lastTimestamp(a) - lastTimestamp(b));
  return sessions;
}

/**
 * Group commits into sessions by (author, time gap).
 *
 * @param commits - Raw commit list (any order)
 * @param gapMinutes - Silence threshold; gap >= this starts a new session
 * @returns Sessions sorted by timestamp ascending
 */
export function groupIntoSessions(commits: CommitInfo[], gapMinutes: number): Session[] {
  // Filter out merge commits
  const filtered = commits.filter((c) => !MERGE_SUBJECT.test(c.body.split("\n")[0]));
  return partitionIntoAuthorSessions(filtered, (c) => c, gapMinutes).map((slice) => ({
    author: slice[0].author,
    timestamp: slice[slice.length - 1].timestamp,
    commitCount: slice.length,
    isFix: slice.some((c) => isBugFixCommit(c.body)),
  }));
}

/** One chunk-level session: its representative timestamp and whether any of its
 * raw commits was a bug fix. */
export interface ChunkSession {
  timestamp: number; // last commit timestamp in session
  isFix: boolean;
}

/**
 * Group chunk-level timestamps into sessions by (author, time gap), carrying a
 * per-session bug-fix flag (OR of the member commits' flags).
 *
 * Uses parallel arrays from ChunkAccumulator. A session is a fix session iff any
 * raw commit grouped into it was a bug fix — this is what lets the squash-mode
 * bugFixRate keep numerator (fix sessions) and denominator (sessions) in one unit.
 *
 * @param timestamps - Raw commit timestamps (any order)
 * @param authors - Parallel array of authors (same length as timestamps)
 * @param isFix - Parallel array of bug-fix flags (missing entries treated false)
 * @param gapMinutes - Silence threshold; gap >= this starts a new session
 * @returns Sessions (last ts + isFix per session), sorted by timestamp ascending
 */
export function groupTimestampsIntoFixSessions(
  timestamps: number[],
  authors: string[],
  isFix: boolean[],
  gapMinutes: number,
): ChunkSession[] {
  if (timestamps.length === 0) return [];

  // Group ORIGINAL indices by author so isFix stays aligned after the per-author sort.
  const byAuthor = new Map<string, number[]>();
  for (let i = 0; i < timestamps.length; i++) {
    const author = authors[i] ?? "unknown";
    const list = byAuthor.get(author);
    if (list) {
      list.push(i);
    } else {
      byAuthor.set(author, [i]);
    }
  }

  const gapSec = gapMinutes * 60;
  const sessions: ChunkSession[] = [];

  byAuthor.forEach((indices) => {
    indices.sort((a, b) => timestamps[a] - timestamps[b]);

    let sessionEnd = timestamps[indices[0]];
    let sessionFix = isFix[indices[0]] ?? false;
    for (let i = 1; i < indices.length; i++) {
      if (timestamps[indices[i]] - timestamps[indices[i - 1]] >= gapSec) {
        sessions.push({ timestamp: sessionEnd, isFix: sessionFix });
        sessionFix = false;
      }
      sessionEnd = timestamps[indices[i]];
      sessionFix = sessionFix || (isFix[indices[i]] ?? false);
    }
    sessions.push({ timestamp: sessionEnd, isFix: sessionFix });
  });

  sessions.sort((a, b) => a.timestamp - b.timestamp);
  return sessions;
}

/**
 * Group chunk-level timestamps into sessions, returning one timestamp per
 * session. Thin projection over {@link groupTimestampsIntoFixSessions} (single
 * grouping algorithm) for callers that don't need the bug-fix flag.
 */
export function groupTimestampsIntoSessions(timestamps: number[], authors: string[], gapMinutes: number): number[] {
  return groupTimestampsIntoFixSessions(timestamps, authors, [], gapMinutes).map((s) => s.timestamp);
}
