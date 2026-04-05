/**
 * File-level signal assembler.
 *
 * Composes pure metric extractors into a complete GitFileSignals object.
 * Replaces the monolithic computeFileSignals() function.
 */

import type { CommitInfo, FileChurnData } from "../../../../../adapters/git/types.js";
import type { GitFileSignals } from "../../types.js";
import type { SquashOptions } from "../metrics.js";
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
import { groupIntoSessions } from "./sessions.js";

export function assembleFileSignals(
  churnData: FileChurnData,
  currentLineCount: number,
  squashOpts?: SquashOptions,
  bugFixShas?: Set<string>,
): GitFileSignals {
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

  // Squash-aware: use session count for churn-dependent metrics
  const useSquash = squashOpts?.squashAwareSessions === true;
  const sessions = useSquash ? groupIntoSessions(commits, squashOpts?.sessionGapMinutes ?? 30) : null;

  // Session-derived synthetic commits for count-dependent extractors
  const countSource: CommitInfo[] | null = sessions
    ? sessions.map((s) => ({
        sha: "",
        author: s.author,
        authorEmail: "",
        timestamp: s.timestamp,
        body: s.isFix ? "fix: session" : "feat: session",
        parents: [],
      }))
    : null;

  return {
    dominantAuthor: authorship.author,
    dominantAuthorEmail: authorship.email,
    authors: authorship.authors,
    dominantAuthorPct: authorship.pct,
    lastModifiedAt: temporal.lastModifiedAt,
    firstCreatedAt: temporal.firstCreatedAt,
    lastCommitHash: temporal.lastCommitHash,
    ageDays: temporal.ageDays,
    commitCount: countSource ? countSource.length : commits.length,
    linesAdded: churnData.linesAdded,
    linesDeleted: churnData.linesDeleted,
    relativeChurn: computeRelativeChurn(churnData.linesAdded, churnData.linesDeleted, currentLineCount),
    recencyWeightedFreq: computeRecencyWeightedFreq(countSource ?? commits),
    changeDensity: computeChangeDensity(countSource ?? commits),
    churnVolatility: computeChurnVolatility(countSource ?? commits),
    bugFixRate: computeBugFixRate(countSource ?? commits, bugFixShas),
    contributorCount: authorship.contributorCount,
    taskIds: extractAllTaskIds(commits),
  };
}
