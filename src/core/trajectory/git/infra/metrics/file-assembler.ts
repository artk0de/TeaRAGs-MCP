/**
 * File-level signal assembler.
 *
 * Composes pure metric extractors into a complete GitFileSignals object.
 * Replaces the monolithic computeFileSignals() function.
 */

import type { FileChurnData } from "../../../../adapters/git/types.js";
import type { GitFileSignals } from "../../types.js";
import {
  computeBugFixRate,
  computeChangeDensity,
  computeChurnVolatility,
  computeDominantAuthor,
  computeRecencyWeightedFreq,
  computeRelativeChurn,
  computeTemporalMetrics,
  extractAllTaskIds,
} from "./extractors.js";

export function assembleFileSignals(churnData: FileChurnData, currentLineCount: number): GitFileSignals {
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

  const authorship = computeDominantAuthor(commits);
  const temporal = computeTemporalMetrics(commits);

  return {
    dominantAuthor: authorship.author,
    dominantAuthorEmail: authorship.email,
    authors: authorship.authors,
    dominantAuthorPct: authorship.pct,
    lastModifiedAt: temporal.lastModifiedAt,
    firstCreatedAt: temporal.firstCreatedAt,
    lastCommitHash: temporal.lastCommitHash,
    ageDays: temporal.ageDays,
    commitCount: commits.length,
    linesAdded: churnData.linesAdded,
    linesDeleted: churnData.linesDeleted,
    relativeChurn: computeRelativeChurn(churnData.linesAdded, churnData.linesDeleted, currentLineCount),
    recencyWeightedFreq: computeRecencyWeightedFreq(commits),
    changeDensity: computeChangeDensity(commits),
    churnVolatility: computeChurnVolatility(commits),
    bugFixRate: computeBugFixRate(commits),
    contributorCount: authorship.contributorCount,
    taskIds: extractAllTaskIds(commits),
  };
}
