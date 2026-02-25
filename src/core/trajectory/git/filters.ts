/**
 * Git filter descriptors — declarative Qdrant filter definitions
 * extracted from hardcoded logic in SearchModule.
 *
 * Each FilterDescriptor maps a search parameter to one or more
 * Qdrant filter conditions, replacing the imperative if/push chains.
 *
 * gitPayloadFields documents all git-related payload fields
 * stored in Qdrant points (file-level and chunk-level).
 */

import type { FieldDoc, FilterDescriptor } from "../types.js";

export const gitFilters: FilterDescriptor[] = [
  {
    param: "author",
    description: "Filter by dominant author name",
    type: "string",
    toCondition: (value: unknown) => [
      {
        key: "git.dominantAuthor",
        match: { value: value as string },
      },
    ],
  },
  {
    param: "modifiedAfter",
    description: "Filter code modified after this date (ISO string)",
    type: "string",
    toCondition: (value: unknown) => [
      {
        key: "git.lastModifiedAt",
        range: { gte: Math.floor(new Date(value as string).getTime() / 1000) },
      },
    ],
  },
  {
    param: "modifiedBefore",
    description: "Filter code modified before this date (ISO string)",
    type: "string",
    toCondition: (value: unknown) => [
      {
        key: "git.lastModifiedAt",
        range: { lte: Math.floor(new Date(value as string).getTime() / 1000) },
      },
    ],
  },
  {
    param: "minAgeDays",
    description: "Filter code older than N days",
    type: "number",
    toCondition: (value: unknown) => [
      {
        key: "git.ageDays",
        range: { gte: value as number },
      },
    ],
  },
  {
    param: "maxAgeDays",
    description: "Filter code newer than N days",
    type: "number",
    toCondition: (value: unknown) => [
      {
        key: "git.ageDays",
        range: { lte: value as number },
      },
    ],
  },
  {
    param: "minCommitCount",
    description: "Filter by minimum commit count (churn indicator)",
    type: "number",
    toCondition: (value: unknown) => [
      {
        key: "git.commitCount",
        range: { gte: value as number },
      },
    ],
  },
  {
    param: "taskId",
    description: "Filter by task/ticket ID from commit messages",
    type: "string",
    toCondition: (value: unknown) => [
      {
        key: "git.taskIds",
        match: { any: [value as string] },
      },
    ],
  },
];

export const gitPayloadFields: FieldDoc[] = [
  // ── File-level fields ──
  {
    key: "git.file.commitCount",
    type: "number",
    description: "Total commits modifying this file",
  },
  {
    key: "git.file.ageDays",
    type: "number",
    description: "Days since last modification",
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
  },
  {
    key: "git.file.relativeChurn",
    type: "number",
    description: "Churn relative to file size (linesAdded + linesDeleted) / currentLines",
  },
  {
    key: "git.file.recencyWeightedFreq",
    type: "number",
    description: "Recency-weighted commit frequency",
  },
  {
    key: "git.file.changeDensity",
    type: "number",
    description: "Commits per month",
  },
  {
    key: "git.file.churnVolatility",
    type: "number",
    description: "Standard deviation of commit intervals in days",
  },
  {
    key: "git.file.bugFixRate",
    type: "number",
    description: "Percentage of bug-fix commits (0-100)",
  },
  {
    key: "git.file.contributorCount",
    type: "number",
    description: "Number of distinct contributors",
  },
  {
    key: "git.file.taskIds",
    type: "string[]",
    description: "Task/ticket IDs extracted from commit messages",
  },

  // ── Chunk-level fields ──
  {
    key: "git.chunk.commitCount",
    type: "number",
    description: "Commits touching this specific chunk",
  },
  {
    key: "git.chunk.churnRatio",
    type: "number",
    description: "Chunk's share of file churn (0-1)",
  },
  {
    key: "git.chunk.contributorCount",
    type: "number",
    description: "Distinct contributors to this chunk",
  },
  {
    key: "git.chunk.bugFixRate",
    type: "number",
    description: "Bug-fix rate for this chunk (0-100)",
  },
  {
    key: "git.chunk.ageDays",
    type: "number",
    description: "Days since last modification to this chunk",
  },
  {
    key: "git.chunk.relativeChurn",
    type: "number",
    description: "Churn relative to chunk size",
  },
  {
    key: "git.chunk.recencyWeightedFreq",
    type: "number",
    description: "Chunk-level recency-weighted commit frequency",
  },
  {
    key: "git.chunk.changeDensity",
    type: "number",
    description: "Chunk-level change density (commits per month)",
  },
];
