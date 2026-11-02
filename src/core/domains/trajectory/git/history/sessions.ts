/**
 * Author-session grouping for git commits.
 *
 * Groups commits into sessions by (author identity, time gap). The co-change
 * build reads each partition as an author burst; git signals count commits.
 */

import type { CommitInfo } from "../../../../adapters/vcs/index.js";
import { authorIdentityKey } from "./author-identity.js";
import { isBugFixCommit, MERGE_SUBJECT } from "./utils.js";

export interface Session {
  author: string;
  timestamp: number; // last commit timestamp in session
  commitCount: number;
  isFix: boolean;
}

/**
 * Partition items into sessions by (author, time gap), keeping every member.
 *
 * The ONE (author identity, gap) grouping rule: `groupIntoSessions` reduces
 * each partition to per-session counts, and the co-change build
 * (`trajectory/codegraph/temporal`) reads each partition as an author burst
 * under its own history-derived gap. Members are ordered oldest first; sessions by their last member's
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
  // Keyed by author IDENTITY (mailmap-applied email), not display name — one
  // person committing under two names is one burst (bd tea-rags-mcp-nsxzh).
  const byAuthor = new Map<string, T[]>();
  for (const item of items) {
    const author = authorIdentityKey(commitOf(item));
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
