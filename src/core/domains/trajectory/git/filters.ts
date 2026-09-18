/**
 * Git filter descriptors — declarative Qdrant filter definitions.
 *
 * Each FilterDescriptor maps a search parameter to one or more
 * Qdrant filter conditions. File-only signals use git.file.* paths.
 * Level-aware filters (age, commitCount, taskId, author) use git.${level}.*;
 * each declares its own default level, which applies when the caller passes
 * none.
 */

import type { FilterConditionResult, FilterDescriptor, FilterLevel } from "../../../contracts/index.js";

const DAY_SECONDS = 86_400;

/** Exact match on the blame-dominant (live-line) author at the given level. */
function blameOwnerCondition(value: unknown, level: FilterLevel): FilterConditionResult {
  return { must: [{ key: `git.${level}.blameDominantAuthor`, match: { value: value as string } }] };
}

/**
 * Age filters compare the stored last-commit timestamp against QUERY-time now.
 * The payload's `ageDays` is stamped at enrichment and never refreshed on
 * points whose file is not re-enriched, so filtering on it drifts (tea-rags-
 * mcp-9mwny). The range keeps the old whole-day contract (ageDays =
 * floor(days)). `gt: 0` excludes the chunk no-commit sentinel: the chunk
 * assembler writes `lastModifiedAt: 0` for a chunk no commit touched, and a
 * doc chunk or a file without history carries no timestamp at all (the
 * is_empty guard).
 */
function lastCommitAgeCondition(key: string, range: { gt: number; lte?: number }): FilterConditionResult {
  return {
    must: [{ key, range }],
    must_not: [{ is_empty: { key } }],
  };
}

function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
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
  {
    // age ≥ N days ⟺ lastModifiedAt ≤ now − N days.
    param: "minAgeDays",
    description: "Filter code whose last commit is at least N days old (query-time)",
    type: "number",
    toCondition: (value: unknown, level: FilterLevel = "chunk") =>
      lastCommitAgeCondition(`git.${level}.lastModifiedAt`, {
        gt: 0,
        lte: nowEpochSeconds() - (value as number) * DAY_SECONDS,
      }),
  },
  {
    // floor(age) ≤ N ⟺ age < N + 1 days ⟺ lastModifiedAt > now − (N + 1) days.
    param: "maxAgeDays",
    description: "Filter code whose last commit is at most N days old (query-time; 0 = within a day)",
    type: "number",
    toCondition: (value: unknown, level: FilterLevel = "chunk") =>
      lastCommitAgeCondition(`git.${level}.lastModifiedAt`, {
        gt: Math.max(0, nowEpochSeconds() - ((value as number) + 1) * DAY_SECONDS),
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
