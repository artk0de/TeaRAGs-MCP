/**
 * Pure git-specific metric functions.
 *
 * Stateless, no I/O — safe to test and reuse independently.
 * Extracted from git-log-reader.ts for SRP.
 */

import type { FileChurnData } from "../../../../../adapters/git/types.js";
import { extractTaskIds } from "../../utils.js";
import type { ChunkChurnOverlay, GitFileMetadata } from "./types.js";

/**
 * Accumulated raw data for a single chunk, collected during hunk mapping.
 * Pure input for computeChunkOverlay — no I/O dependency.
 */
export interface ChunkAccumulator {
  commitShas: Set<string>;
  authors: Set<string>;
  bugFixCount: number;
  lastModifiedAt: number;
  linesAdded: number;
  linesDeleted: number;
}

const BUG_FIX_PATTERN = /\b(fix|bug|hotfix|patch|resolve[sd]?|defect)\b/i;
const MERGE_SUBJECT = /^Merge\b/i;

/**
 * Check if a commit is a bug fix based on its message.
 * Skips merge commits — "Merge branch 'fix/TD-123'" is not a fix signal,
 * the actual fix commit within the branch is already counted separately.
 */
export function isBugFixCommit(body: string): boolean {
  const subject = body.split("\n")[0];
  if (MERGE_SUBJECT.test(subject)) return false;
  return BUG_FIX_PATTERN.test(body);
}

/**
 * Check if a hunk range overlaps with a chunk range.
 * Both ranges are inclusive: [start, end].
 */
export function overlaps(hunkStart: number, hunkEnd: number, chunkStart: number, chunkEnd: number): boolean {
  return hunkStart <= chunkEnd && hunkEnd >= chunkStart;
}

/**
 * Compute churn metrics for a single file from its commit history.
 */
export function computeFileMetadata(churnData: FileChurnData, currentLineCount: number): GitFileMetadata {
  const nowSec = Date.now() / 1000;
  const { commits } = churnData;

  if (commits.length === 0) {
    return {
      dominantAuthor: "unknown",
      dominantAuthorEmail: "",
      authors: [],
      dominantAuthorPct: 0,
      lastModifiedAt: 0,
      firstCreatedAt: 0,
      lastCommitHash: "",
      ageDays: 0,
      commitCount: 0,
      linesAdded: churnData.linesAdded,
      linesDeleted: churnData.linesDeleted,
      relativeChurn: 0,
      recencyWeightedFreq: 0,
      changeDensity: 0,
      churnVolatility: 0,
      bugFixRate: 0,
      contributorCount: 0,
      taskIds: [],
    };
  }

  // Sort commits by timestamp ascending
  const sorted = [...commits].sort((a, b) => a.timestamp - b.timestamp);

  // Author aggregation (by commit count)
  const authorCounts = new Map<string, { count: number; email: string }>();
  const allTaskIds = new Set<string>();

  for (const c of commits) {
    const existing = authorCounts.get(c.author);
    if (existing) {
      existing.count++;
    } else {
      authorCounts.set(c.author, { count: 1, email: c.authorEmail });
    }
    for (const tid of extractTaskIds(c.body)) {
      allTaskIds.add(tid);
    }
  }

  // Find dominant author
  let dominantAuthor = "";
  let dominantAuthorEmail = "";
  let maxCount = 0;
  for (const [author, data] of authorCounts) {
    if (data.count > maxCount) {
      maxCount = data.count;
      dominantAuthor = author;
      dominantAuthorEmail = data.email;
    }
  }

  const lastCommit = sorted[sorted.length - 1];
  const firstCommit = sorted[0];
  const ageDays = Math.max(0, Math.floor((nowSec - lastCommit.timestamp) / 86400));

  // Relative churn
  const totalChurn = churnData.linesAdded + churnData.linesDeleted;
  const relativeChurn = totalChurn / Math.max(currentLineCount, 1);

  // Recency-weighted frequency: Σ exp(-0.1 × daysAgo)
  const recencyWeightedFreq = commits.reduce((sum, c) => {
    const daysAgo = (nowSec - c.timestamp) / 86400;
    return sum + Math.exp(-0.1 * daysAgo);
  }, 0);

  // Change density: commits / months
  const spanMonths = Math.max((lastCommit.timestamp - firstCommit.timestamp) / (86400 * 30), 1);
  const changeDensity = commits.length / spanMonths;

  // Churn volatility: stddev of days between consecutive commits
  let churnVolatility = 0;
  if (sorted.length > 1) {
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((sorted[i].timestamp - sorted[i - 1].timestamp) / 86400);
    }
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance = gaps.reduce((sum, g) => sum + (g - mean) ** 2, 0) / gaps.length;
    churnVolatility = Math.sqrt(variance);
  }

  // Bug fix rate: percentage of commits with fix/bug/hotfix/patch keywords
  const bugFixRate = Math.round((commits.filter((c) => isBugFixCommit(c.body)).length / commits.length) * 100);
  const contributorCount = authorCounts.size;

  return {
    dominantAuthor,
    dominantAuthorEmail,
    authors: Array.from(authorCounts.keys()),
    dominantAuthorPct: Math.round((maxCount / commits.length) * 100),
    lastModifiedAt: lastCommit.timestamp,
    firstCreatedAt: firstCommit.timestamp,
    lastCommitHash: lastCommit.sha,
    ageDays,
    commitCount: commits.length,
    linesAdded: churnData.linesAdded,
    linesDeleted: churnData.linesDeleted,
    relativeChurn: Math.round(relativeChurn * 100) / 100,
    recencyWeightedFreq: Math.round(recencyWeightedFreq * 100) / 100,
    changeDensity: Math.round(changeDensity * 100) / 100,
    churnVolatility: Math.round(churnVolatility * 100) / 100,
    bugFixRate,
    contributorCount,
    taskIds: Array.from(allTaskIds),
  };
}

/**
 * Compute chunk-level churn overlay from accumulated raw data.
 *
 * @param acc - Per-chunk accumulated data from hunk mapping
 * @param fileCommitCount - File-level commit count (for ratio normalization)
 * @param fileContributorCount - File-level contributor count (cap, optional)
 */
export function computeChunkOverlay(
  acc: ChunkAccumulator,
  fileCommitCount: number,
  fileContributorCount?: number,
  chunkLineCount?: number,
): ChunkChurnOverlay {
  const nowSec = Date.now() / 1000;
  const commitCount = acc.commitShas.size;
  const totalCommitsForChunk = commitCount || 1;
  const totalChurn = acc.linesAdded + acc.linesDeleted;
  const lineCount = Math.max(chunkLineCount ?? 1, 1);

  return {
    commitCount,
    churnRatio: Math.round((commitCount / Math.max(fileCommitCount, 1)) * 100) / 100,
    contributorCount:
      fileContributorCount !== undefined ? Math.min(acc.authors.size, fileContributorCount) : acc.authors.size,
    bugFixRate: commitCount > 0 ? Math.round((acc.bugFixCount / totalCommitsForChunk) * 100) : 0,
    lastModifiedAt: acc.lastModifiedAt,
    ageDays: acc.lastModifiedAt > 0 ? Math.max(0, Math.floor((nowSec - acc.lastModifiedAt) / 86400)) : 0,
    relativeChurn: Math.round((totalChurn / lineCount) * 100) / 100,
  };
}
