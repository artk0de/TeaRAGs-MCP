/**
 * Git filter descriptors — declarative Qdrant filter definitions.
 *
 * Each FilterDescriptor maps a search parameter to one or more
 * Qdrant filter conditions. File-only signals use git.file.* paths.
 * Level-aware signals (ageDays, commitCount) use git.${level}.* with
 * default level "chunk".
 */

import type { FilterConditionResult, FilterDescriptor, FilterLevel } from "../../../contracts/index.js";

/** Exact match on the blame-dominant (live-line) author at the given level. */
function blameOwnerCondition(value: unknown, level: FilterLevel): FilterConditionResult {
  return { must: [{ key: `git.${level}.blameDominantAuthor`, match: { value: value as string } }] };
}

export const gitFilters: FilterDescriptor[] = [
  {
    param: "recentAuthor",
    description:
      "Filter by recent-activity dominant author (commit-count based, within log window). Matches name OR email.",
    type: "string",
    toCondition: (value: unknown) => ({
      // (name == value) OR (email == value) — single param, two ways to identify
      must: [
        {
          should: [
            { key: "git.file.recentDominantAuthor", match: { value: value as string } },
            { key: "git.file.recentDominantAuthorEmail", match: { value: value as string } },
          ],
        },
      ],
    }),
  },
  {
    param: "blameOwner",
    description: "Filter by live-line owner — author of most lines in HEAD via git blame",
    type: "string",
    toCondition: (value: unknown) => blameOwnerCondition(value, "file"),
  },
  {
    // The MCP-facing name (`author` in the tool schema): same blame-owner
    // semantics as blameOwner, but level-aware so `level: "chunk"` narrows to
    // the chunk's own live lines. Without this descriptor the registry had no
    // param "author" and silently dropped the filter (tea-rags-mcp-9mwny).
    param: "author",
    description:
      "Filter by blame-dominant author — owner of most live lines (git blame HEAD). Level-aware, default file.",
    type: "string",
    toCondition: (value: unknown, level: FilterLevel = "file") => blameOwnerCondition(value, level),
  },
  {
    param: "minRecentContributors",
    description:
      "Filter by minimum distinct authors who recently committed to the file (within log window). High = peer-reviewed code.",
    type: "number",
    toCondition: (value: unknown) => ({
      must: [{ key: "git.file.recentContributorCount", range: { gte: value as number } }],
    }),
  },
  {
    param: "maxRecentContributors",
    description:
      "Filter by maximum distinct authors who recently committed to the file. Low (e.g. 1) surfaces panic-mode commits or abandoned ownership.",
    type: "number",
    toCondition: (value: unknown) => ({
      must: [{ key: "git.file.recentContributorCount", range: { lte: value as number } }],
    }),
  },
  {
    param: "modifiedAfter",
    description: "Filter code modified after this date (ISO string)",
    type: "string",
    toCondition: (value: unknown) => ({
      must: [
        { key: "git.file.lastModifiedAt", range: { gte: Math.floor(new Date(value as string).getTime() / 1000) } },
      ],
    }),
  },
  {
    param: "modifiedBefore",
    description: "Filter code modified before this date (ISO string)",
    type: "string",
    toCondition: (value: unknown) => ({
      must: [
        { key: "git.file.lastModifiedAt", range: { lte: Math.floor(new Date(value as string).getTime() / 1000) } },
      ],
    }),
  },
  // Age filters: ageDays 0 is the freshest code (last commit < 24h before
  // enrichment, day-floored), never a no-data sentinel — both assemblers leave
  // the key ABSENT when there is no history (assembleChunkSignals writes
  // undefined; a file without commits gets no overlay at all). So no `gt: 0`
  // guard: the is_empty guard alone excludes the no-data points.
  {
    param: "minAgeDays",
    description: "Filter code older than N days",
    type: "number",
    toCondition: (value: unknown, level: FilterLevel = "chunk") => ({
      must: [{ key: `git.${level}.ageDays`, range: { gte: value as number } }],
      must_not: [{ is_empty: { key: `git.${level}.ageDays` } }],
    }),
  },
  {
    param: "maxAgeDays",
    description: "Filter code newer than N days",
    type: "number",
    toCondition: (value: unknown, level: FilterLevel = "chunk") => ({
      must: [{ key: `git.${level}.ageDays`, range: { lte: value as number } }],
      must_not: [{ is_empty: { key: `git.${level}.ageDays` } }],
    }),
  },
  {
    param: "minCommitCount",
    description: "Filter by minimum commit count (churn indicator)",
    type: "number",
    toCondition: (value: unknown, level: FilterLevel = "chunk") => ({
      must: [{ key: `git.${level}.commitCount`, range: { gte: value as number } }],
    }),
  },
  {
    param: "taskId",
    description: "Filter by task/ticket ID from commit messages",
    type: "string",
    toCondition: (value: unknown, level: FilterLevel = "file") => ({
      must: [{ key: `git.${level}.taskIds`, match: { any: [value as string] } }],
    }),
  },
];
