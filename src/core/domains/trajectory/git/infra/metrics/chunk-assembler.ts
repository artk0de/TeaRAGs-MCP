/**
 * Chunk-level signal assembler.
 *
 * Replaces computeChunkSignals() monolith with assembler pattern.
 * Computes ChunkChurnOverlay from a ChunkAccumulator.
 */

import type { ChunkChurnOverlay } from "../../types.js";
import { SMOOTHING_ALPHA, type ChunkAccumulator, type SquashOptions } from "../metrics.js";
import { groupTimestampsIntoSessions } from "./sessions.js";

export function assembleChunkSignals(
  acc: ChunkAccumulator,
  fileCommitCount: number,
  fileContributorCount?: number,
  chunkLineCount?: number,
  squashOpts?: SquashOptions,
): ChunkChurnOverlay {
  const nowSec = Date.now() / 1000;
  const totalChurn = acc.linesAdded + acc.linesDeleted;
  const lineCount = Math.max(chunkLineCount ?? 1, 1);

  // Squash-aware: use session timestamps instead of raw commit timestamps
  const useSquash = squashOpts?.squashAwareSessions === true;
  const effectiveTimestamps = useSquash
    ? groupTimestampsIntoSessions(acc.commitTimestamps, acc.commitAuthors, squashOpts?.sessionGapMinutes ?? 30)
    : acc.commitTimestamps;
  const commitCount = useSquash ? effectiveTimestamps.length : acc.commitShas.size;

  // Chunk-level recencyWeightedFreq: sum of exp(-0.1 * daysAgo)
  const recencyWeightedFreq =
    effectiveTimestamps.length > 0
      ? Math.round(
          effectiveTimestamps.reduce((sum, ts) => {
            const daysAgo = (nowSec - ts) / 86400;
            return sum + Math.exp(-0.1 * daysAgo);
          }, 0) * 100,
        ) / 100
      : 0;

  // Chunk-level changeDensity: sessions (or commits) / months
  let changeDensity = 0;
  if (effectiveTimestamps.length > 0) {
    const minTs = Math.min(...effectiveTimestamps);
    const maxTs = Math.max(...effectiveTimestamps);
    const spanMonths = Math.max((maxTs - minTs) / (86400 * 30), 1);
    changeDensity = Math.round((effectiveTimestamps.length / spanMonths) * 100) / 100;
  }

  // Churn volatility: stddev of days between consecutive sessions (or commits)
  let churnVolatility = 0;
  const sortedTs = [...effectiveTimestamps].sort((a, b) => a - b);
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
    ageDays: acc.lastModifiedAt > 0 ? Math.max(0, Math.floor((nowSec - acc.lastModifiedAt) / 86400)) : undefined,
    relativeChurn: Math.round((totalChurn / lineCount) * (1 - Math.exp(-lineCount / 30)) * 100) / 100,
    recencyWeightedFreq,
    changeDensity,
    churnVolatility: Math.round(churnVolatility * 100) / 100,
    taskIds: Array.from(acc.taskIds),
  };
}
