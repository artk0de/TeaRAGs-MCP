/**
 * Chunk-level signal assembler.
 *
 * Replaces computeChunkSignals() monolith with assembler pattern.
 * Computes ChunkChurnOverlay from a ChunkAccumulator.
 */

import type { ChunkChurnOverlay } from "../../types.js";
import { SMOOTHING_ALPHA, type ChunkAccumulator } from "../metrics.js";

export function assembleChunkSignals(
  acc: ChunkAccumulator,
  fileCommitCount: number,
  fileContributorCount?: number,
  chunkLineCount?: number,
): ChunkChurnOverlay {
  const nowSec = Date.now() / 1000;
  const commitCount = acc.commitShas.size;
  const totalChurn = acc.linesAdded + acc.linesDeleted;
  const lineCount = Math.max(chunkLineCount ?? 1, 1);

  // Chunk-level recencyWeightedFreq: sum of exp(-0.1 * daysAgo)
  const recencyWeightedFreq =
    acc.commitTimestamps.length > 0
      ? Math.round(
          acc.commitTimestamps.reduce((sum, ts) => {
            const daysAgo = (nowSec - ts) / 86400;
            return sum + Math.exp(-0.1 * daysAgo);
          }, 0) * 100,
        ) / 100
      : 0;

  // Chunk-level changeDensity: commits / months
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
