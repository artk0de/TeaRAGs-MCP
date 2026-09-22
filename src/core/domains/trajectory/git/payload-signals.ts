/**
 * Git payload signal descriptors.
 *
 * Describes all git-related payload fields stored in Qdrant points
 * (file-level and chunk-level). Used for MCP schema generation
 * and collection-level stats computation.
 *
 * Numeric signals declare `stats.labels` for percentile caching
 * and human-readable label resolution in ranking overlays.
 *
 * Every chunk-scoped signal here samples `CALLABLE_CHUNK_TYPES` only. These
 * signals describe a unit of code that gets CHANGED, and `block` chunks — barrel
 * re-exports, import lists, top-level constants — outnumber callables on a
 * typical index, so without the filter a method's history is ranked against a
 * population that is mostly declaration surface.
 */

import { CALLABLE_CHUNK_TYPES } from "../../../contracts/types/chunker.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";

export const gitPayloadSignalDescriptors: PayloadSignalDescriptor[] = [
  // ── File-level signals ──
  {
    key: "git.file.commitCount",
    type: "number",
    description: "Total commits modifying this file",
    stats: {
      labels: { p25: "low", p50: "typical", p75: "high", p95: "extreme" },
      // Bug-fix-rate confidence block references "p10" of file-scope commitCount
      // as a label-clamp threshold (and "p25" via the labels declaration above).
      // Declare p10 here so collection-stats computes it at index time.
      percentilesToCompute: [10],
      dedupeByFile: true,
      // A tie at 1 means most files have a single commit; one commit is `low`.
      bandTieBreak: "lower",
    },
    essential: true,
  },
  {
    key: "git.file.ageDays",
    type: "number",
    description:
      "Days since last modification (stored stamp, frozen at enrichment — age reads derive from lastModifiedAt at query time)",
    stats: { labels: { p25: "recent", p50: "typical", p75: "old", p95: "legacy" }, dedupeByFile: true },
    essential: true,
  },
  {
    key: "git.file.lastModifiedAt",
    type: "timestamp",
    description:
      "Unix seconds of the file's last commit; the source age/recency/overlay ageDays derive from at query time (percentiles feed the now-relative floor and label bands)",
    stats: {
      // p5 → adaptive-bounds age floor; p25/p50 → inverted ageDays label bands
      // and filter-preset thresholds (bd tea-rags-mcp-9ot33).
      percentilesToCompute: [5, 25, 50],
      // Same file value on every chunk of the file, so it samples per file —
      // and it must sample the same population as the ageDays bands it now
      // replaces, or the derived bands describe a different set of files.
      dedupeByFile: true,
    },
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
    // 100% dominance IS the top band, so a tie there keeps the upper name.
    stats: { labels: { p25: "shared", p50: "mixed", p75: "concentrated", p95: "silo" }, dedupeByFile: true },
  },
  {
    key: "git.file.fileChurnCount",
    type: "number",
    description: "Total lines churned (added + deleted) — absolute change volume",
    stats: { labels: { p25: "minimal", p50: "moderate", p75: "significant", p95: "massive" }, dedupeByFile: true },
  },
  {
    key: "git.file.relativeChurn",
    type: "number",
    description: "Churn relative to file size (linesAdded + linesDeleted) / currentLines",
    stats: { labels: { p75: "normal", p95: "high" }, dedupeByFile: true },
  },
  {
    key: "git.file.recencyWeightedFreq",
    type: "number",
    description: "Recency-weighted commit frequency",
    // Filter preset references p50 of file-scope recencyWeightedFreq; labels
    // only declare p75/p95, so declare p50 here for index-time computation.
    stats: { labels: { p75: "normal", p95: "burst" }, percentilesToCompute: [50], dedupeByFile: true },
  },
  {
    key: "git.file.changeDensity",
    type: "number",
    description: "Commits per month",
    stats: { labels: { p50: "calm", p75: "active", p95: "intense" }, dedupeByFile: true },
  },
  {
    key: "git.file.churnVolatility",
    type: "number",
    description: "Standard deviation of commit intervals in days",
    stats: { labels: { p75: "stable", p95: "erratic" }, dedupeByFile: true },
  },
  {
    key: "git.file.bugFixRate",
    type: "number",
    description: "Percentage of bug-fix commits (0-100)",
    stats: {
      labels: { p50: "healthy", p75: "concerning", p95: "critical" },
      // A file whose commits held no fix measured 0 — it belongs in the
      // distribution. Sampling only the non-zero values describes "files that
      // had at least one fix" and pushes every bucket boundary up.
      zeroIsValidObservation: true,
      // Already a 0–100 percentage — render with "%" suffix, no ×100 scaling.
      format: "percent100",
      // Filter preset references p25 of file-scope bugFixRate; labels declare
      // p50/p75/p95, so declare p25 here for index-time computation.
      percentilesToCompute: [25],
      dedupeByFile: true,
      // A corpus that stamps one rate on every file (a shallow clone, a vendored
      // tree) ties all three bands. The rate then grades nothing, so the honest
      // reading is the least alarming one — `critical` for an entire repository
      // is a false alarm, not a finding.
      bandTieBreak: "lower",
      confidence: {
        support: "commitCount",
        score: { threshold: 10, adaptivePercentile: 25 },
        label: {
          rules: [
            { whenSupportBelow: "p10", fallback: 5, ceiling: "healthy" },
            { whenSupportBelow: "p25", fallback: 10, ceiling: "concerning" },
          ],
        },
      },
    },
  },
  {
    key: "git.file.recentContributorCount",
    type: "number",
    description: "Number of distinct contributors",
    // One contributor is `solo`, never `team` — a tie at 1 takes the lower name.
    stats: { labels: { p50: "solo", p75: "team", p95: "crowd" }, dedupeByFile: true, bandTieBreak: "lower" },
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
    // Ties at 100 on any single-author repository, and 100% ownership IS a deep
    // silo — the default upper tie-break is the correct reading here.
    stats: { labels: { p50: "shared", p75: "concentrated", p90: "silo", p95: "deep-silo" }, dedupeByFile: true },
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
    // One author is `solo`. Measured: ties at 1 on rust/go/swift sent it to
    // `crowd`, and on tea-rags/python to `team`.
    stats: {
      labels: { p25: "solo", p50: "pair", p75: "team", p95: "crowd" },
      dedupeByFile: true,
      bandTieBreak: "lower",
    },
    essential: true,
  },

  // ── Chunk-level signals ──
  {
    key: "git.chunk.churnRatio",
    type: "number",
    description: "Chunk's share of file churn (0-1)",
    stats: { labels: { p75: "normal", p95: "concentrated" }, chunkTypeFilter: CALLABLE_CHUNK_TYPES },
  },
  {
    key: "git.chunk.commitCount",
    type: "number",
    description: "Commits touching this specific chunk",
    stats: {
      labels: { p25: "low", p50: "typical", p75: "high", p95: "extreme" },
      chunkTypeFilter: CALLABLE_CHUNK_TYPES,
      // Mirrors git.file.commitCount — bugFixRate confidence references "p10"
      // of chunk-scope commitCount too.
      percentilesToCompute: [10],
      // Ties at 1 wherever most chunks carry a single commit (taxdome: 57% of
      // them). One commit is `low`, not `typical`.
      bandTieBreak: "lower",
    },
    essential: true,
  },
  {
    key: "git.chunk.ageDays",
    type: "number",
    description:
      "Days since last modification to this chunk (stored stamp, frozen at enrichment — age reads derive from lastModifiedAt at query time)",
    stats: {
      labels: { p25: "recent", p50: "typical", p75: "old", p95: "legacy" },
      chunkTypeFilter: CALLABLE_CHUNK_TYPES,
    },
    essential: true,
  },
  {
    key: "git.chunk.lastModifiedAt",
    type: "timestamp",
    description:
      "Unix seconds of the last commit touching this chunk; the source age/recency/overlay ageDays derive from at query time (percentiles feed the now-relative floor and label bands)",
    stats: {
      // Mirrors the file-level declaration — see git.file.lastModifiedAt.
      percentilesToCompute: [5, 25, 50],
      // Sampled over the same chunk types as the ageDays bands it replaces. A
      // declaration file scope decides; here the population has to match, or
      // the derived bands are read off a set the stored ones never described.
      chunkTypeFilter: CALLABLE_CHUNK_TYPES,
    },
  },
  {
    key: "git.chunk.recentContributorCount",
    type: "number",
    description: "Distinct contributors to this chunk",
    stats: { labels: { p50: "solo", p95: "crowd" }, chunkTypeFilter: CALLABLE_CHUNK_TYPES, bandTieBreak: "lower" },
  },
  {
    key: "git.chunk.bugFixRate",
    type: "number",
    description: "Bug-fix rate for this chunk (0-100)",
    stats: {
      labels: { p50: "healthy", p75: "concerning", p95: "critical" },
      chunkTypeFilter: CALLABLE_CHUNK_TYPES,
      // Same reading as the file-scope twin: bands that tie grade nothing, so
      // an indistinguishable rate reports as the least alarming name.
      bandTieBreak: "lower",
      // Same reading as the file scope, and the chunk sample needs it more: the
      // survivors are dominated by single-commit chunks whose one commit was a
      // fix, so dropping the zeros collapses p50/p75/p95 onto 100 and every
      // value — 100% included — resolves to "healthy".
      zeroIsValidObservation: true,
      // Already a 0–100 percentage — render with "%" suffix, no ×100 scaling.
      format: "percent100",
      confidence: {
        support: "commitCount",
        score: { threshold: 10, adaptivePercentile: 25 },
        label: {
          rules: [
            { whenSupportBelow: "p10", fallback: 5, ceiling: "healthy" },
            { whenSupportBelow: "p25", fallback: 10, ceiling: "concerning" },
          ],
        },
      },
    },
  },
  {
    key: "git.chunk.relativeChurn",
    type: "number",
    description: "Churn relative to chunk size",
    stats: { labels: { p75: "normal", p95: "high" }, chunkTypeFilter: CALLABLE_CHUNK_TYPES },
  },
  {
    key: "git.chunk.recencyWeightedFreq",
    type: "number",
    description: "Chunk-level recency-weighted commit frequency",
    stats: { labels: { p75: "normal", p95: "burst" }, chunkTypeFilter: CALLABLE_CHUNK_TYPES },
  },
  {
    key: "git.chunk.changeDensity",
    type: "number",
    description: "Chunk-level change density (commits per month)",
    stats: { labels: { p75: "active", p95: "intense" }, chunkTypeFilter: CALLABLE_CHUNK_TYPES },
  },
  {
    key: "git.chunk.churnVolatility",
    type: "number",
    description: "Standard deviation of commit intervals for this chunk (days)",
    stats: { labels: { p75: "stable", p95: "erratic" }, chunkTypeFilter: CALLABLE_CHUNK_TYPES },
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
    stats: {
      labels: { p50: "shared", p75: "concentrated", p90: "silo", p95: "deep-silo" },
      chunkTypeFilter: CALLABLE_CHUNK_TYPES,
    },
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
    stats: {
      labels: { p25: "solo", p50: "pair", p75: "team", p95: "crowd" },
      chunkTypeFilter: CALLABLE_CHUNK_TYPES,
      // See the file-scope twin: a lone author must read `solo`.
      bandTieBreak: "lower",
    },
    essential: true,
  },
];
