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
    essential: true,
  },
  {
    key: "git.file.ageDays",
    type: "number",
    description: "Days since last modification",
    stats: { percentiles: [95] },
    essential: true,
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
  {
    key: "git.chunk.churnRatio",
    type: "number",
    description: "Chunk's share of file churn (0-1)",
    stats: { percentiles: [95] },
  },
  {
    key: "git.chunk.commitCount",
    type: "number",
    description: "Commits touching this specific chunk",
    stats: { percentiles: [95] },
    essential: true,
  },
  {
    key: "git.chunk.ageDays",
    type: "number",
    description: "Days since last modification to this chunk",
    stats: { percentiles: [95] },
    essential: true,
  },
  {
    key: "git.chunk.contributorCount",
    type: "number",
    description: "Distinct contributors to this chunk",
    stats: { percentiles: [95] },
  },
  {
    key: "git.chunk.bugFixRate",
    type: "number",
    description: "Bug-fix rate for this chunk (0-100)",
    stats: { percentiles: [95] },
  },
  {
    key: "git.chunk.relativeChurn",
    type: "number",
    description: "Churn relative to chunk size",
    stats: { percentiles: [95] },
  },
  {
    key: "git.chunk.recencyWeightedFreq",
    type: "number",
    description: "Chunk-level recency-weighted commit frequency",
    stats: { percentiles: [95] },
  },
  {
    key: "git.chunk.changeDensity",
    type: "number",
    description: "Chunk-level change density (commits per month)",
    stats: { percentiles: [95] },
  },
  {
    key: "git.chunk.churnVolatility",
    type: "number",
    description: "Standard deviation of commit intervals for this chunk (days)",
    stats: { percentiles: [95] },
  },
  {
    key: "git.chunk.taskIds",
    type: "string[]",
    description: "Task/ticket IDs extracted from commit messages touching this chunk",
  },
];
