/**
 * Git payload signal descriptors.
 *
 * Describes all git-related payload fields stored in Qdrant points
 * (file-level and chunk-level). Used for MCP schema generation
 * and collection-level stats computation.
 *
 * Numeric signals declare `stats.labels` for percentile caching
 * and human-readable label resolution in ranking overlays.
 */

import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";

export const gitPayloadSignalDescriptors: PayloadSignalDescriptor[] = [
  // ── File-level signals ──
  {
    key: "git.file.commitCount",
    type: "number",
    description: "Total commits modifying this file",
    stats: { labels: { p25: "low", p50: "typical", p75: "high", p95: "extreme" } },
    essential: true,
  },
  {
    key: "git.file.ageDays",
    type: "number",
    description: "Days since last modification",
    stats: { labels: { p25: "recent", p50: "typical", p75: "old", p95: "legacy" } },
    essential: true,
  },
  {
    key: "git.file.recentDominantAuthor",
    type: "string",
    description: "Author with most commits to this file",
  },
  {
    key: "git.file.recentAuthors",
    type: "string[]",
    description: "All contributing authors",
  },
  {
    key: "git.file.recentDominantAuthorPct",
    type: "number",
    description: "Percentage of commits by dominant author",
    stats: { labels: { p25: "shared", p50: "mixed", p75: "concentrated", p95: "silo" } },
  },
  {
    key: "git.file.fileChurnCount",
    type: "number",
    description: "Total lines churned (added + deleted) — absolute change volume",
    stats: { labels: { p25: "minimal", p50: "moderate", p75: "significant", p95: "massive" } },
  },
  {
    key: "git.file.relativeChurn",
    type: "number",
    description: "Churn relative to file size (linesAdded + linesDeleted) / currentLines",
    stats: { labels: { p75: "normal", p95: "high" } },
  },
  {
    key: "git.file.recencyWeightedFreq",
    type: "number",
    description: "Recency-weighted commit frequency",
    stats: { labels: { p75: "normal", p95: "burst" } },
  },
  {
    key: "git.file.changeDensity",
    type: "number",
    description: "Commits per month",
    stats: { labels: { p50: "calm", p75: "active", p95: "intense" } },
  },
  {
    key: "git.file.churnVolatility",
    type: "number",
    description: "Standard deviation of commit intervals in days",
    stats: { labels: { p75: "stable", p95: "erratic" } },
  },
  {
    key: "git.file.bugFixRate",
    type: "number",
    description: "Percentage of bug-fix commits (0-100)",
    stats: {
      labels: { p50: "healthy", p75: "concerning", p95: "critical" },
      confidence: {
        support: "commitCount",
        score: { threshold: 10 },
        label: {
          rules: [
            { whenSupportBelow: 5, ceiling: "healthy" },
            { whenSupportBelow: 10, ceiling: "concerning" },
          ],
        },
      },
    },
  },
  {
    key: "git.file.recentContributorCount",
    type: "number",
    description: "Number of distinct contributors",
    stats: { labels: { p50: "solo", p75: "team", p95: "crowd" } },
  },
  {
    key: "git.file.taskIds",
    type: "string[]",
    description: "Task/ticket IDs extracted from commit messages",
    essential: true,
  },

  // ── File-level line-based ownership (from git blame HEAD) ──
  {
    key: "git.file.blameDominantAuthor",
    type: "string",
    description: "Author owning the largest share of live lines (from git blame HEAD)",
    essential: true,
  },
  {
    key: "git.file.blameDominantAuthorPct",
    type: "number",
    description: "Percentage of live lines owned by blameDominantAuthor (0-100)",
    stats: { labels: { p50: "shared", p75: "concentrated", p90: "silo", p95: "deep-silo" } },
    essential: true,
  },
  {
    key: "git.file.blameAuthors",
    type: "string[]",
    description: "Top-N contributors to live lines, sorted by share desc",
  },
  {
    key: "git.file.blameContributorCount",
    type: "number",
    description: "Distinct authors of live lines",
    stats: { labels: { p25: "solo", p50: "pair", p75: "team", p95: "crowd" } },
    essential: true,
  },

  // ── Chunk-level signals ──
  {
    key: "git.chunk.churnRatio",
    type: "number",
    description: "Chunk's share of file churn (0-1)",
    stats: { labels: { p75: "normal", p95: "concentrated" } },
  },
  {
    key: "git.chunk.commitCount",
    type: "number",
    description: "Commits touching this specific chunk",
    stats: { labels: { p25: "low", p50: "typical", p75: "high", p95: "extreme" } },
    essential: true,
  },
  {
    key: "git.chunk.ageDays",
    type: "number",
    description: "Days since last modification to this chunk",
    stats: { labels: { p25: "recent", p50: "typical", p75: "old", p95: "legacy" } },
    essential: true,
  },
  {
    key: "git.chunk.recentContributorCount",
    type: "number",
    description: "Distinct contributors to this chunk",
    stats: { labels: { p50: "solo", p95: "crowd" } },
  },
  {
    key: "git.chunk.bugFixRate",
    type: "number",
    description: "Bug-fix rate for this chunk (0-100)",
    stats: {
      labels: { p50: "healthy", p75: "concerning", p95: "critical" },
      confidence: {
        support: "commitCount",
        score: { threshold: 10 },
        label: {
          rules: [
            { whenSupportBelow: 5, ceiling: "healthy" },
            { whenSupportBelow: 10, ceiling: "concerning" },
          ],
        },
      },
    },
  },
  {
    key: "git.chunk.relativeChurn",
    type: "number",
    description: "Churn relative to chunk size",
    stats: { labels: { p75: "normal", p95: "high" } },
  },
  {
    key: "git.chunk.recencyWeightedFreq",
    type: "number",
    description: "Chunk-level recency-weighted commit frequency",
    stats: { labels: { p75: "normal", p95: "burst" } },
  },
  {
    key: "git.chunk.changeDensity",
    type: "number",
    description: "Chunk-level change density (commits per month)",
    stats: { labels: { p75: "active", p95: "intense" } },
  },
  {
    key: "git.chunk.churnVolatility",
    type: "number",
    description: "Standard deviation of commit intervals for this chunk (days)",
    stats: { labels: { p75: "stable", p95: "erratic" } },
  },
  {
    key: "git.chunk.taskIds",
    type: "string[]",
    description: "Task/ticket IDs extracted from commit messages touching this chunk",
    essential: true,
  },

  // ── Chunk-level line-based ownership (blame lines inside chunk range) ──
  {
    key: "git.chunk.blameDominantAuthor",
    type: "string",
    description: "Author owning the largest share of live lines inside the chunk's range",
    essential: true,
  },
  {
    key: "git.chunk.blameDominantAuthorPct",
    type: "number",
    description: "Percentage of chunk's live lines owned by blameDominantAuthor (0-100)",
    stats: { labels: { p50: "shared", p75: "concentrated", p90: "silo", p95: "deep-silo" } },
    essential: true,
  },
  {
    key: "git.chunk.blameAuthors",
    type: "string[]",
    description: "Top-N contributors to the chunk's live lines, sorted by share desc",
  },
  {
    key: "git.chunk.blameContributorCount",
    type: "number",
    description: "Distinct authors of the chunk's live lines",
    stats: { labels: { p25: "solo", p50: "pair", p75: "team", p95: "crowd" } },
    essential: true,
  },
];
