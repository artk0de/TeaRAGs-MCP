/**
 * Pure git-specific metric functions.
 *
 * Stateless, no I/O — safe to test and reuse independently.
 * Extracted from git-log-reader.ts for SRP.
 */

import type { FileChurnData } from "../../../../adapters/git/types.js";
import type { ChunkChurnOverlay, GitFileSignals } from "../types.js";
import { extractTaskIds } from "./utils.js";

/**
 * Accumulated raw data for a single chunk, collected during hunk mapping.
 * Pure input for computeChunkSignals — no I/O dependency.
 */
export interface ChunkAccumulator {
  commitShas: Set<string>;
  authors: Set<string>;
  bugFixCount: number;
  lastModifiedAt: number;
  linesAdded: number;
  linesDeleted: number;
  commitTimestamps: number[];
  /** Per-timestamp author (parallel array with commitTimestamps) for session grouping */
  commitAuthors: string[];
  taskIds: Set<string>;
}

/** Squash-aware session options passed through the call chain. */
export interface SquashOptions {
  squashAwareSessions?: boolean;
  sessionGapMinutes?: number;
}

/** Jeffreys prior for Laplace smoothing of bugFixRate (alpha = 0.5). */
export const SMOOTHING_ALPHA = 0.5;

/**
 * Cosmetic/infrastructure patterns to EXCLUDE — not real bug fixes.
 * Checked against the full commit body (case-insensitive).
 */
const COSMETIC_PATTERN =
  /\bfix(?:e[sd])?\s+(?:typo|lint|linter|format|formatting|style|whitespace|indentation|imports?|tests?|specs?|flaky|rubocop|eslint|prettier|ci|pipeline|migration|review|code\s*review|conflicts?)\b/i;

const TEXT_FIX_PATTERN = /\btext\s+fix(?:es)?\b/i;

/**
 * Strong positive signals — conventional commits and explicit tags.
 * Checked against the SUBJECT line only.
 */
const CONVENTIONAL_FIX = /^(?:hot)?fix(?:\([^)]+\))?!?:/i;
const TAG_FIX = /^\[(?:Fix|Bug|Hotfix|Bugfix)\]/i;

/**
 * Ticket + Fix verb: "[TD-123] Fix ..." or "TD-123 Fix ..." or "[PROJ-456] fixed ..."
 * Checked against the SUBJECT line only.
 */
const TICKET_FIX = /^\[?[A-Z]+-\d+\]?\s+(?:fix|fixed|fixes)\b/i;

/**
 * GitHub/GitLab closing keywords in body: "fixes #123", "resolves #456", "closes #789"
 * Checked against the FULL body.
 */
const CLOSES_ISSUE = /\b(?:fix|fixe[sd]|resolve[sd]?|close[sd]?)\s+#\d+/i;

export const MERGE_SUBJECT = /^Merge\b/i;

/**
 * Check if a commit is a bug fix based on its message.
 *
 * Classification rules (in order):
 * 1. Skip merge commits — branch prefix is handled by merge-branch-resolver
 * 2. Exclude cosmetic patterns (fix typo, fix lint, fix tests, etc.)
 * 3. Match conventional prefix: fix:, hotfix:, fix(scope):
 * 4. Match explicit tag: [Fix], [Bug], [HOTFIX], [Bugfix]
 * 5. Match ticket + Fix verb: [TD-123] Fix ..., TD-456 fixed ...
 * 6. Match GitHub closing keywords: fixes #123, resolves #456
 */
export function isBugFixCommit(body: string): boolean {
  const subject = body.split("\n")[0];

  // 1. Skip merge commits
  if (MERGE_SUBJECT.test(subject)) return false;

  // 2. Exclude cosmetic/infrastructure fixes
  if (COSMETIC_PATTERN.test(body)) return false;
  if (TEXT_FIX_PATTERN.test(body)) return false;

  // 3. Conventional commit prefix
  if (CONVENTIONAL_FIX.test(subject)) return true;

  // 4. Explicit tag
  if (TAG_FIX.test(subject)) return true;

  // 5. Ticket + Fix verb
  if (TICKET_FIX.test(subject)) return true;

  // 6. GitHub/GitLab closing keywords (anywhere in body)
  if (CLOSES_ISSUE.test(body)) return true;

  return false;
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
export function computeFileSignals(churnData: FileChurnData, currentLineCount: number): GitFileSignals {
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

  // Bug fix rate: Laplace-smoothed (Jeffreys prior) percentage of fix commits
  const bugFixCount = commits.filter((c) => isBugFixCommit(c.body)).length;
  const bugFixRate = Math.round(((bugFixCount + SMOOTHING_ALPHA) / (commits.length + 2 * SMOOTHING_ALPHA)) * 100);
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
export function computeChunkSignals(
  acc: ChunkAccumulator,
  fileCommitCount: number,
  fileContributorCount?: number,
  chunkLineCount?: number,
): ChunkChurnOverlay {
  const nowSec = Date.now() / 1000;
  const commitCount = acc.commitShas.size;
  const totalChurn = acc.linesAdded + acc.linesDeleted;
  const lineCount = Math.max(chunkLineCount ?? 1, 1);

  const recencyWeightedFreq =
    acc.commitTimestamps.length > 0
      ? Math.round(
          acc.commitTimestamps.reduce((sum, ts) => {
            const daysAgo = (nowSec - ts) / 86400;
            return sum + Math.exp(-0.1 * daysAgo);
          }, 0) * 100,
        ) / 100
      : 0;

  let changeDensity = 0;
  if (acc.commitTimestamps.length > 0) {
    const minTs = Math.min(...acc.commitTimestamps);
    const maxTs = Math.max(...acc.commitTimestamps);
    const spanMonths = Math.max((maxTs - minTs) / (86400 * 30), 1);
    changeDensity = Math.round((acc.commitTimestamps.length / spanMonths) * 100) / 100;
  }

  // Churn volatility: stddev of days between consecutive commits
  let churnVolatility = 0;
  const sortedTs = [...acc.commitTimestamps].sort((a, b) => a - b);
  if (sortedTs.length > 1) {
    const gaps: number[] = [];
    for (let i = 1; i < sortedTs.length; i++) {
      gaps.push((sortedTs[i] - sortedTs[i - 1]) / 86400);
    }
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance = gaps.reduce((sum, g) => sum + (g - mean) ** 2, 0) / gaps.length;
    churnVolatility = Math.sqrt(variance);
  }

  return {
    commitCount,
    churnRatio: Math.round((commitCount / Math.max(fileCommitCount, 1)) * 100) / 100,
    contributorCount:
      fileContributorCount !== undefined ? Math.min(acc.authors.size, fileContributorCount) : acc.authors.size,
    bugFixRate:
      commitCount > 0
        ? Math.round(((acc.bugFixCount + SMOOTHING_ALPHA) / (commitCount + 2 * SMOOTHING_ALPHA)) * 100)
        : 0,
    lastModifiedAt: acc.lastModifiedAt,
    ageDays: acc.lastModifiedAt > 0 ? Math.max(0, Math.floor((nowSec - acc.lastModifiedAt) / 86400)) : 0,
    relativeChurn: Math.round((totalChurn / lineCount) * (1 - Math.exp(-lineCount / 30)) * 100) / 100,
    recencyWeightedFreq,
    changeDensity,
    churnVolatility: Math.round(churnVolatility * 100) / 100,
    taskIds: Array.from(acc.taskIds),
  };
}
