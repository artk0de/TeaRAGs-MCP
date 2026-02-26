/**
 * Pure metric extractor functions.
 *
 * Each function computes one metric family from commit data.
 * Stateless, no I/O -- Strategy pattern for metric computation.
 *
 * Extracted from the monolithic computeFileSignals() in metrics.ts.
 */

import type { CommitInfo } from "../../../../adapters/git/types.js";
import { isBugFixCommit, SMOOTHING_ALPHA } from "../metrics.js";
import { extractTaskIds } from "../utils.js";

export interface AuthorshipResult {
  author: string;
  email: string;
  pct: number;
  authors: string[];
  contributorCount: number;
}

export interface TemporalResult {
  lastModifiedAt: number;
  firstCreatedAt: number;
  lastCommitHash: string;
  ageDays: number;
}

/**
 * Compute dominant author and contributor stats from commit history.
 */
export function computeDominantAuthor(commits: CommitInfo[]): AuthorshipResult {
  if (commits.length === 0) {
    return { author: "unknown", email: "", pct: 0, authors: [], contributorCount: 0 };
  }
  const authorCounts = new Map<string, { count: number; email: string }>();
  for (const c of commits) {
    const existing = authorCounts.get(c.author);
    if (existing) {
      existing.count++;
    } else {
      authorCounts.set(c.author, { count: 1, email: c.authorEmail });
    }
  }
  let dominant = "";
  let dominantEmail = "";
  let maxCount = 0;
  for (const [author, data] of authorCounts) {
    if (data.count > maxCount) {
      maxCount = data.count;
      dominant = author;
      dominantEmail = data.email;
    }
  }
  return {
    author: dominant,
    email: dominantEmail,
    pct: Math.round((maxCount / commits.length) * 100),
    authors: Array.from(authorCounts.keys()),
    contributorCount: authorCounts.size,
  };
}

/**
 * Compute temporal metrics: timestamps, age, last commit hash.
 */
export function computeTemporalMetrics(commits: CommitInfo[]): TemporalResult {
  if (commits.length === 0) {
    return { lastModifiedAt: 0, firstCreatedAt: 0, lastCommitHash: "", ageDays: 0 };
  }
  const sorted = [...commits].sort((a, b) => a.timestamp - b.timestamp);
  const last = sorted[sorted.length - 1];
  const first = sorted[0];
  const nowSec = Date.now() / 1000;
  return {
    lastModifiedAt: last.timestamp,
    firstCreatedAt: first.timestamp,
    lastCommitHash: last.sha,
    ageDays: Math.max(0, Math.floor((nowSec - last.timestamp) / 86400)),
  };
}

/**
 * Compute relative churn: (linesAdded + linesDeleted) / max(currentLineCount, 1).
 * Rounded to 2 decimal places.
 */
export function computeRelativeChurn(linesAdded: number, linesDeleted: number, currentLineCount: number): number {
  const totalChurn = linesAdded + linesDeleted;
  const result = totalChurn / Math.max(currentLineCount, 1);
  return Math.round(result * 100) / 100;
}

/**
 * Compute recency-weighted frequency: sum of exp(-0.1 * daysAgo) per commit.
 * Rounded to 2 decimal places.
 */
export function computeRecencyWeightedFreq(commits: CommitInfo[]): number {
  if (commits.length === 0) return 0;
  const nowSec = Date.now() / 1000;
  const sum = commits.reduce((acc, c) => {
    const daysAgo = (nowSec - c.timestamp) / 86400;
    return acc + Math.exp(-0.1 * daysAgo);
  }, 0);
  return Math.round(sum * 100) / 100;
}

/**
 * Compute change density: commits per month.
 * Uses minimum 1 month span. Rounded to 2 decimal places.
 */
export function computeChangeDensity(commits: CommitInfo[]): number {
  if (commits.length === 0) return 0;
  const sorted = [...commits].sort((a, b) => a.timestamp - b.timestamp);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const spanMonths = Math.max((last.timestamp - first.timestamp) / (86400 * 30), 1);
  return Math.round((commits.length / spanMonths) * 100) / 100;
}

/**
 * Compute churn volatility: stddev of days between consecutive commits.
 * Rounded to 2 decimal places.
 */
export function computeChurnVolatility(commits: CommitInfo[]): number {
  if (commits.length <= 1) return 0;
  const sorted = [...commits].sort((a, b) => a.timestamp - b.timestamp);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((sorted[i].timestamp - sorted[i - 1].timestamp) / 86400);
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((sum, g) => sum + (g - mean) ** 2, 0) / gaps.length;
  return Math.round(Math.sqrt(variance) * 100) / 100;
}

/**
 * Compute bug fix rate using Laplace smoothing (Jeffreys prior).
 * Formula: (bugFixCount + alpha) / (totalCommits + 2*alpha) * 100
 */
export function computeBugFixRate(commits: CommitInfo[]): number {
  if (commits.length === 0) return 0;
  const bugFixCount = commits.filter((c) => isBugFixCommit(c.body)).length;
  return Math.round(((bugFixCount + SMOOTHING_ALPHA) / (commits.length + 2 * SMOOTHING_ALPHA)) * 100);
}

/**
 * Collect unique task IDs from all commit messages.
 */
export function extractAllTaskIds(commits: CommitInfo[]): string[] {
  const allIds = new Set<string>();
  for (const c of commits) {
    for (const tid of extractTaskIds(c.body)) {
      allIds.add(tid);
    }
  }
  return Array.from(allIds);
}
