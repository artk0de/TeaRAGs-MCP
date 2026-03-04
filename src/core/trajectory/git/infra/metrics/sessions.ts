/**
 * Squash-aware session grouping for git commits.
 *
 * Groups commits into sessions by (author, time gap).
 * When enabled via config, session count replaces commit count
 * in churn-related signals, reducing noise from agent-style
 * burst commits.
 */

import type { CommitInfo } from "../../../../adapters/git/types.js";
import { isBugFixCommit, MERGE_SUBJECT } from "../metrics.js";

export interface Session {
  author: string;
  timestamp: number; // last commit timestamp in session
  commitCount: number;
  isFix: boolean;
}

/**
 * Group commits into sessions by (author, time gap).
 *
 * @param commits - Raw commit list (any order)
 * @param gapMinutes - Silence threshold; gap >= this starts a new session
 * @returns Sessions sorted by timestamp ascending
 */
export function groupIntoSessions(commits: CommitInfo[], gapMinutes: number): Session[] {
  if (commits.length === 0) return [];

  // Filter out merge commits
  const filtered = commits.filter((c) => !MERGE_SUBJECT.test(c.body.split("\n")[0]));
  if (filtered.length === 0) return [];

  // Group by author
  const byAuthor = new Map<string, CommitInfo[]>();
  for (const c of filtered) {
    const list = byAuthor.get(c.author);
    if (list) {
      list.push(c);
    } else {
      byAuthor.set(c.author, [c]);
    }
  }

  const gapSec = gapMinutes * 60;
  const sessions: Session[] = [];

  byAuthor.forEach((authorCommits, author) => {
    // Sort by timestamp ascending
    authorCommits.sort((a, b) => a.timestamp - b.timestamp);

    let sessionStart = 0;
    for (let i = 1; i <= authorCommits.length; i++) {
      const isEnd = i === authorCommits.length;
      const gap = isEnd ? Infinity : authorCommits[i].timestamp - authorCommits[i - 1].timestamp;

      if (gap >= gapSec || isEnd) {
        const slice = authorCommits.slice(sessionStart, i);
        sessions.push({
          author,
          timestamp: slice[slice.length - 1].timestamp,
          commitCount: slice.length,
          isFix: slice.some((c) => isBugFixCommit(c.body)),
        });
        sessionStart = i;
      }
    }
  });

  // Sort sessions by timestamp ascending
  sessions.sort((a, b) => a.timestamp - b.timestamp);

  return sessions;
}

/**
 * Group chunk-level timestamps into sessions by (author, time gap).
 *
 * Uses parallel arrays of timestamps and authors from ChunkAccumulator.
 * Returns one timestamp per session (last timestamp in each group).
 *
 * @param timestamps - Raw commit timestamps (any order)
 * @param authors - Parallel array of authors (same length as timestamps)
 * @param gapMinutes - Silence threshold; gap >= this starts a new session
 * @returns Session timestamps (last ts per session), sorted ascending
 */
export function groupTimestampsIntoSessions(timestamps: number[], authors: string[], gapMinutes: number): number[] {
  if (timestamps.length === 0) return [];

  // Build (timestamp, author) pairs and group by author
  const byAuthor = new Map<string, number[]>();
  for (let i = 0; i < timestamps.length; i++) {
    const author = authors[i] ?? "unknown";
    const list = byAuthor.get(author);
    if (list) {
      list.push(timestamps[i]);
    } else {
      byAuthor.set(author, [timestamps[i]]);
    }
  }

  const gapSec = gapMinutes * 60;
  const sessionTimestamps: number[] = [];

  byAuthor.forEach((authorTs) => {
    authorTs.sort((a, b) => a - b);

    let sessionEnd = authorTs[0];
    for (let i = 1; i < authorTs.length; i++) {
      if (authorTs[i] - authorTs[i - 1] >= gapSec) {
        sessionTimestamps.push(sessionEnd);
      }
      sessionEnd = authorTs[i];
    }
    sessionTimestamps.push(sessionEnd);
  });

  sessionTimestamps.sort((a, b) => a - b);
  return sessionTimestamps;
}
