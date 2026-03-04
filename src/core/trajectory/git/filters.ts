/**
 * Git filter descriptors — declarative Qdrant filter definitions.
 *
 * Each FilterDescriptor maps a search parameter to one or more
 * Qdrant filter conditions. File-only signals use git.file.* paths.
 * Level-aware signals (ageDays, commitCount) use git.${level}.* with
 * default level "chunk".
 */

import type { FilterDescriptor, FilterLevel } from "../../contracts/index.js";

export const gitFilters: FilterDescriptor[] = [
  {
    param: "author",
    description: "Filter by dominant author name",
    type: "string",
    toCondition: (value: unknown) => [{ key: "git.file.dominantAuthor", match: { value: value as string } }],
  },
  {
    param: "modifiedAfter",
    description: "Filter code modified after this date (ISO string)",
    type: "string",
    toCondition: (value: unknown) => [
      { key: "git.file.lastModifiedAt", range: { gte: Math.floor(new Date(value as string).getTime() / 1000) } },
    ],
  },
  {
    param: "modifiedBefore",
    description: "Filter code modified before this date (ISO string)",
    type: "string",
    toCondition: (value: unknown) => [
      { key: "git.file.lastModifiedAt", range: { lte: Math.floor(new Date(value as string).getTime() / 1000) } },
    ],
  },
  {
    param: "minAgeDays",
    description: "Filter code older than N days",
    type: "number",
    toCondition: (value: unknown, level: FilterLevel = "chunk") => [
      { key: `git.${level}.ageDays`, range: { gte: value as number } },
    ],
  },
  {
    param: "maxAgeDays",
    description: "Filter code newer than N days",
    type: "number",
    toCondition: (value: unknown, level: FilterLevel = "chunk") => [
      { key: `git.${level}.ageDays`, range: { lte: value as number } },
    ],
  },
  {
    param: "minCommitCount",
    description: "Filter by minimum commit count (churn indicator)",
    type: "number",
    toCondition: (value: unknown, level: FilterLevel = "chunk") => [
      { key: `git.${level}.commitCount`, range: { gte: value as number } },
    ],
  },
  {
    param: "taskId",
    description: "Filter by task/ticket ID from commit messages",
    type: "string",
    toCondition: (value: unknown, level: FilterLevel = "file") => [
      { key: `git.${level}.taskIds`, match: { any: [value as string] } },
    ],
  },
];
