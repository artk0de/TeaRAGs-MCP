/**
 * Git payload signal descriptors.
 *
 * Describes all git-related payload fields stored in Qdrant points
 * (file-level and chunk-level). Used for MCP schema generation
 * and collection-level stats computation.
 *
 * Numeric signals declare `stats` for percentile caching.
 */

import type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";

export const gitPayloadSignalDescriptors: PayloadSignalDescriptor[] = [
  // ── File-level signals ──
  {
    key: "git.file.commitCount",
    type: "number",
    description: "Total commits modifying this file",
    stats: { percentiles: [25, 50, 75, 95] },
  },
  {
    key: "git.file.ageDays",
    type: "number",
    description: "Days since last modification",
    stats: { percentiles: [95] },
  },
  {
    key: "git.file.dominantAuthor",
    type: "string",
    description: "Author with most commits to this file",
  },
  {
    key: "git.file.authors",
    type: "string[]",
    description: "All contributing authors",
  },
  {
    key: "git.file.dominantAuthorPct",
    type: "number",
    description: "Percentage of commits by dominant author",
    stats: { percentiles: [95] },
  },
  {
    key: "git.file.relativeChurn",
    type: "number",
    description: "Churn relative to file size (linesAdded + linesDeleted) / currentLines",
    stats: { percentiles: [95] },
  },
  {
    key: "git.file.recencyWeightedFreq",
    type: "number",
    description: "Recency-weighted commit frequency",
    stats: { percentiles: [95] },
  },
  {
    key: "git.file.changeDensity",
    type: "number",
    description: "Commits per month",
    stats: { percentiles: [95] },
  },
  {
    key: "git.file.churnVolatility",
    type: "number",
    description: "Standard deviation of commit intervals in days",
    stats: { percentiles: [95] },
  },
  {
    key: "git.file.bugFixRate",
    type: "number",
    description: "Percentage of bug-fix commits (0-100)",
    stats: { percentiles: [95] },
  },
  {
    key: "git.file.contributorCount",
    type: "number",
    description: "Number of distinct contributors",
    stats: { percentiles: [95] },
  },
  {
    key: "git.file.taskIds",
    type: "string[]",
    description: "Task/ticket IDs extracted from commit messages",
  },

  // ── Chunk-level signals ──
  // Unique chunk signal (no file-level equivalent)
  {
    key: "git.chunk.churnRatio",
    type: "number",
    description: "Chunk's share of file churn (0-1)",
    stats: { percentiles: [95] },
  },
  // Mirrored from file-level (same suffix, chunk-scoped descriptions)
  ...(
    [
      ["commitCount", "Commits touching this specific chunk"],
      ["ageDays", "Days since last modification to this chunk"],
      ["contributorCount", "Distinct contributors to this chunk"],
      ["bugFixRate", "Bug-fix rate for this chunk (0-100)"],
      ["relativeChurn", "Churn relative to chunk size"],
      ["recencyWeightedFreq", "Chunk-level recency-weighted commit frequency"],
      ["changeDensity", "Chunk-level change density (commits per month)"],
    ] as const
  ).map(
    ([suffix, description]): PayloadSignalDescriptor => ({
      key: `git.chunk.${suffix}`,
      type: "number",
      description,
      stats: { percentiles: [95] },
    }),
  ),
];
