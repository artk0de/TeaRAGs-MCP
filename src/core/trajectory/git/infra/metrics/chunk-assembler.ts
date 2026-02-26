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
  };
}
