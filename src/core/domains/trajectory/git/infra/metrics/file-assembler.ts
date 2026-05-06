/**
 * File-level signal assembler.
 *
 * Composes pure metric extractors into a complete GitFileSignals object.
 * Replaces the monolithic computeFileSignals() function.
 */

import type { BlameLine, CommitInfo, FileChurnData } from "../../../../../adapters/git/types.js";
import type { GitFileSignals } from "../../types.js";
import { computeBlameOwnership } from "../blame-ownership.js";
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
  blameLines?: BlameLine[],
): GitFileSignals {
  const ownership = blameLines && blameLines.length > 0 ? computeBlameOwnership(blameLines).file : null;
  const { commits } = churnData;

  if (commits.length === 0) {
    return {
      recentDominantAuthor: "unknown",
      recentDominantAuthorEmail: "",
      recentAuthors: [],
      recentDominantAuthorPct: 0,
      lastModifiedAt: 0,
      firstCreatedAt: 0,
      lastCommitHash: "",
      ageDays: 0,
      commitCount: 0,
      linesAdded: churnData.linesAdded,
      linesDeleted: churnData.linesDeleted,
      fileChurnCount: churnData.linesAdded + churnData.linesDeleted,
      relativeChurn: 0,
      recencyWeightedFreq: 0,
      changeDensity: 0,
      churnVolatility: 0,
      bugFixRate: 0,
      recentContributorCount: 0,
      taskIds: [],
      blameDominantAuthor: ownership?.blameDominantAuthor ?? "unknown",
      blameDominantAuthorPct: ownership?.blameDominantAuthorPct ?? 0,
      blameAuthors: ownership?.blameAuthors ?? [],
      blameContributorCount: ownership?.blameContributorCount ?? 0,
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
    recentDominantAuthor: authorship.author,
    recentDominantAuthorEmail: authorship.email,
    recentAuthors: authorship.authors,
    recentDominantAuthorPct: authorship.pct,
    lastModifiedAt: temporal.lastModifiedAt,
    firstCreatedAt: temporal.firstCreatedAt,
    lastCommitHash: temporal.lastCommitHash,
    ageDays: temporal.ageDays,
    commitCount: countSource ? countSource.length : commits.length,
    linesAdded: churnData.linesAdded,
    linesDeleted: churnData.linesDeleted,
    fileChurnCount: churnData.linesAdded + churnData.linesDeleted,
    relativeChurn: computeRelativeChurn(churnData.linesAdded, churnData.linesDeleted, currentLineCount),
    recencyWeightedFreq: computeRecencyWeightedFreq(countSource ?? commits),
    changeDensity: computeChangeDensity(countSource ?? commits),
    churnVolatility: computeChurnVolatility(countSource ?? commits),
    bugFixRate: computeBugFixRate(countSource ?? commits, bugFixShas),
    recentContributorCount: authorship.contributorCount,
    taskIds: extractAllTaskIds(commits),
    // Line-based ownership: from `git blame HEAD` if provided, otherwise unknown defaults.
    blameDominantAuthor: ownership?.blameDominantAuthor ?? "unknown",
    blameDominantAuthorPct: ownership?.blameDominantAuthorPct ?? 0,
    blameAuthors: ownership?.blameAuthors ?? [],
    blameContributorCount: ownership?.blameContributorCount ?? 0,
  };
}
