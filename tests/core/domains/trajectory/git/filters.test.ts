import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PayloadSignalDescriptor } from "../../../../../src/core/contracts/types/trajectory.js";
import { compileFilterPreset } from "../../../../../src/core/domains/trajectory/filter-presets/compiler.js";
import { freshLegacyEditsFilterPreset } from "../../../../../src/core/domains/trajectory/git/filter-presets/fresh-legacy-edits.js";
import { gitFilters } from "../../../../../src/core/domains/trajectory/git/filters.js";
import { gitPayloadSignalDescriptors } from "../../../../../src/core/domains/trajectory/git/payload-signals.js";

const findFilter = (param: string) => gitFilters.find((f) => f.param === param)!;

/**
 * Minimal Qdrant filter evaluator for the shapes git filters compile to —
 * must / must_not / nested should, leaves match.value, match.any, range and
 * is_empty. A missing key fails match and range (Qdrant semantics).
 */
type FilterNode = Record<string, any>;
function payloadAt(payload: Record<string, any>, key: string): unknown {
  let node: any = payload;
  for (const segment of key.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[segment];
  }
  return node;
}
function matchesNode(payload: Record<string, any>, node: FilterNode): boolean {
  if (node.should) return (node.should as FilterNode[]).some((n) => matchesNode(payload, n));
  if (node.must || node.must_not) return matchesQdrantFilter(payload, node);
  if (node.is_empty) {
    const v = payloadAt(payload, node.is_empty.key);
    return v === undefined || v === null || (Array.isArray(v) && v.length === 0);
  }
  const value = payloadAt(payload, node.key);
  if (node.match && "value" in node.match) return value === node.match.value;
  if (node.match?.any) return (node.match.any as unknown[]).includes(value);
  if (node.range) {
    if (typeof value !== "number") return false;
    const { gt, gte, lt, lte } = node.range;
    return (
      (gt === undefined || value > gt) &&
      (gte === undefined || value >= gte) &&
      (lt === undefined || value < lt) &&
      (lte === undefined || value <= lte)
    );
  }
  return false;
}
function matchesQdrantFilter(payload: Record<string, any>, filter: FilterNode | undefined): boolean {
  if (!filter) return true;
  const must = (filter.must ?? []) as FilterNode[];
  const mustNot = (filter.must_not ?? []) as FilterNode[];
  return must.every((n) => matchesNode(payload, n)) && !mustNot.some((n) => matchesNode(payload, n));
}

describe("git filter descriptors", () => {
  it("exports 12 filter descriptors", () => {
    expect(gitFilters).toHaveLength(12);
  });

  it("each filter has required fields", () => {
    for (const f of gitFilters) {
      expect(f.param).toBeTruthy();
      expect(f.description).toBeTruthy();
      expect(typeof f.toCondition).toBe("function");
      expect(["string", "number", "boolean", "string[]"]).toContain(f.type);
    }
  });

  it("recentAuthor filter matches name OR email via should", () => {
    const result = findFilter("recentAuthor").toCondition("alice");
    expect(result.must).toHaveLength(1);
    expect(result.must![0]).toEqual({
      should: [
        { key: "git.file.recentDominantAuthor", match: { value: "alice" } },
        { key: "git.file.recentDominantAuthorEmail", match: { value: "alice" } },
      ],
    });
  });

  it("blameOwner filter uses git.file.blameDominantAuthor (file-only)", () => {
    const result = findFilter("blameOwner").toCondition("alice");
    expect(result.must).toHaveLength(1);
    expect(result.must![0]).toEqual({
      key: "git.file.blameDominantAuthor",
      match: { value: "alice" },
    });
  });

  describe("author (tea-rags-mcp-9mwny: the MCP param had no descriptor and was dropped)", () => {
    const points = [
      { git: { file: { blameDominantAuthor: "Alice" }, chunk: { blameDominantAuthor: "Bob" } } },
      { git: { file: { blameDominantAuthor: "Carol" }, chunk: { blameDominantAuthor: "Alice" } } },
    ];

    it("compiles to the blame-dominant author, file level by default", () => {
      expect(findFilter("author").toCondition("Alice").must).toEqual([
        { key: "git.file.blameDominantAuthor", match: { value: "Alice" } },
      ]);
    });

    it("level 'chunk' reads the chunk's own live-line owner", () => {
      expect(findFilter("author").toCondition("Alice", "chunk").must).toEqual([
        { key: "git.chunk.blameDominantAuthor", match: { value: "Alice" } },
      ]);
    });

    it("a nonexistent author matches no point; a real one matches only its files", () => {
      const nobody = findFilter("author").toCondition("Nobody At All");
      expect(points.filter((p) => matchesQdrantFilter(p, nobody))).toHaveLength(0);

      const alice = findFilter("author").toCondition("Alice");
      expect(points.filter((p) => matchesQdrantFilter(p, alice))).toEqual([points[0]]);
    });
  });

  it("minRecentContributors filter is file-level gte range", () => {
    const result = findFilter("minRecentContributors").toCondition(3);
    expect(result.must![0]).toEqual({
      key: "git.file.recentContributorCount",
      range: { gte: 3 },
    });
  });

  it("maxRecentContributors filter is file-level lte range", () => {
    const result = findFilter("maxRecentContributors").toCondition(1);
    expect(result.must![0]).toEqual({
      key: "git.file.recentContributorCount",
      range: { lte: 1 },
    });
  });

  it("modifiedAfter uses git.file.lastModifiedAt (file-only)", () => {
    const result = findFilter("modifiedAfter").toCondition("2024-01-01");
    expect(result.must).toHaveLength(1);
    expect(result.must![0].key).toBe("git.file.lastModifiedAt");
    expect((result.must![0] as any).range.gte).toBeGreaterThan(0);
  });

  it("modifiedBefore uses git.file.lastModifiedAt (file-only)", () => {
    const result = findFilter("modifiedBefore").toCondition("2025-12-31");
    expect(result.must![0].key).toBe("git.file.lastModifiedAt");
  });

  it("taskId defaults to file level", () => {
    const result = findFilter("taskId").toCondition("JIRA-123");
    expect(result.must![0]).toEqual({
      key: "git.file.taskIds",
      match: { any: ["JIRA-123"] },
    });
  });

  it("taskId respects chunk level param", () => {
    const result = findFilter("taskId").toCondition("JIRA-123", "chunk");
    expect(result.must![0]).toEqual({
      key: "git.chunk.taskIds",
      match: { any: ["JIRA-123"] },
    });
  });
});

describe("contributor (tea-rags-mcp-y1870: any recent-window committer, not only the dominant one)", () => {
  // recentAuthor matches only the TOP recent committer (recentDominantAuthor*),
  // so "what did X work on" misses every file X committed to without dominating.
  // contributor compiles to the complete answer: match.any over
  // git.file.recentAuthors — the same shape the taskId filter uses for taskIds.
  it("compiles to a match.any over git.file.recentAuthors, file level", () => {
    expect(findFilter("contributor").toCondition("Alice")).toEqual({
      must: [{ key: "git.file.recentAuthors", match: { any: ["Alice"] } }],
    });
  });

  it("is file-only — the level param changes nothing", () => {
    expect(findFilter("contributor").toCondition("Alice", "chunk")).toEqual(
      findFilter("contributor").toCondition("Alice"),
    );
  });
});

describe("level-aware filters", () => {
  // Age filters are drift-free (tea-rags-mcp-9mwny): they compare the stored
  // last-commit timestamp against QUERY-time now, never the `ageDays` stamp,
  // which is frozen at enrichment time and goes stale on points not
  // re-enriched. Day semantics match the old ageDays = floor(days) contract:
  // minAgeDays N ⟺ age ≥ N days; maxAgeDays N ⟺ age < N + 1 days.
  const DAY = 86_400;
  const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
  const nowSec = NOW / 1000;
  /** A payload whose last commit was `daysAgo` before NOW, at the given level. */
  const committed = (level: "file" | "chunk", daysAgo: number, staleAgeDays?: number) => ({
    git: {
      [level]: {
        lastModifiedAt: nowSec - Math.round(daysAgo * DAY),
        ...(staleAgeDays !== undefined ? { ageDays: staleAgeDays } : {}),
      },
    },
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("minAgeDays compiles to a query-time lastModifiedAt cutoff, level-aware, chunk by default", () => {
    expect(findFilter("minAgeDays").toCondition(30)).toEqual({
      must: [{ key: "git.chunk.lastModifiedAt", range: { gt: 0, lte: nowSec - 30 * DAY } }],
      must_not: [{ is_empty: { key: "git.chunk.lastModifiedAt" } }],
    });
    const fileLevel = findFilter("minAgeDays").toCondition(30, "file");
    expect(fileLevel.must![0].key).toBe("git.file.lastModifiedAt");
    expect(fileLevel.must_not![0]).toEqual({ is_empty: { key: "git.file.lastModifiedAt" } });
  });

  it("maxAgeDays compiles to a query-time lastModifiedAt cutoff, level-aware, chunk by default", () => {
    expect(findFilter("maxAgeDays").toCondition(7)).toEqual({
      must: [{ key: "git.chunk.lastModifiedAt", range: { gt: nowSec - 8 * DAY } }],
      must_not: [{ is_empty: { key: "git.chunk.lastModifiedAt" } }],
    });
    const fileLevel = findFilter("maxAgeDays").toCondition(7, "file");
    expect(fileLevel.must![0].key).toBe("git.file.lastModifiedAt");
    expect(fileLevel.must_not![0]).toEqual({ is_empty: { key: "git.file.lastModifiedAt" } });
  });

  it("maxAgeDays admits code committed less than a day ago and keeps the whole-day boundary", () => {
    const week = findFilter("maxAgeDays").toCondition(7, "file");
    expect(matchesQdrantFilter(committed("file", 2 / 24), week)).toBe(true);
    expect(matchesQdrantFilter(committed("file", 7.5), week)).toBe(true); // floor(7.5) = 7 ≤ 7
    expect(matchesQdrantFilter(committed("file", 8.5), week)).toBe(false);
    expect(matchesQdrantFilter(committed("file", 2 / 24), findFilter("maxAgeDays").toCondition(0, "file"))).toBe(true);
  });

  it("ignores the enrichment-time ageDays stamp — a stale value never decides the match", () => {
    // Enriched when 1 day old; the last commit is now 56 days back.
    const stale = committed("file", 56, 1);
    expect(matchesQdrantFilter(stale, findFilter("maxAgeDays").toCondition(7, "file"))).toBe(false);
    expect(matchesQdrantFilter(stale, findFilter("minAgeDays").toCondition(30, "file"))).toBe(true);
  });

  it("no git history never matches: lastModifiedAt absent or the chunk no-commit sentinel 0", () => {
    const noCommitChunk = { git: { chunk: { lastModifiedAt: 0, commitCount: 0 } } };
    const docChunk = { git: { file: { lastModifiedAt: nowSec - 3 * DAY } } };
    for (const payload of [noCommitChunk, docChunk, {}]) {
      expect(matchesQdrantFilter(payload, findFilter("minAgeDays").toCondition(0))).toBe(false);
      expect(matchesQdrantFilter(payload, findFilter("maxAgeDays").toCondition(365))).toBe(false);
    }
  });

  it("maxAgeDays agrees with the freshLegacyEdits preset on a freshly enriched point", () => {
    // Both admit a chunk committed two hours ago whose stamp is still current
    // (ageDays 0); the preset reads the stamp, the typed filter the timestamp.
    const fresh = committed("chunk", 2 / 24, 0);
    const presetFilter = compileFilterPreset(freshLegacyEditsFilterPreset, undefined, "chunk");
    const presetChunkAge = { must: presetFilter.must!.filter((c) => "key" in c && c.key === "git.chunk.ageDays") };
    expect(matchesQdrantFilter(fresh, presetChunkAge)).toBe(true);
    expect(matchesQdrantFilter(fresh, findFilter("maxAgeDays").toCondition(7))).toBe(true);
  });

  it("minCommitCount defaults to chunk level", () => {
    const result = findFilter("minCommitCount").toCondition(5);
    expect(result.must![0]).toEqual({
      key: "git.chunk.commitCount",
      range: { gte: 5 },
    });
  });

  it("minCommitCount respects file level param", () => {
    const result = findFilter("minCommitCount").toCondition(5, "file");
    expect(result.must![0].key).toBe("git.file.commitCount");
  });
});

describe("git payload signal descriptors", () => {
  it("exports file-level and chunk-level fields", () => {
    expect(gitPayloadSignalDescriptors.length).toBeGreaterThan(15);
    const fileFields = gitPayloadSignalDescriptors.filter((f) => f.key.startsWith("git.file."));
    const chunkFields = gitPayloadSignalDescriptors.filter((f) => f.key.startsWith("git.chunk."));
    expect(fileFields.length).toBeGreaterThanOrEqual(12);
    expect(chunkFields.length).toBeGreaterThanOrEqual(9);
  });

  it("each entry has only PayloadSignalDescriptor properties (key, type, description)", () => {
    for (const f of gitPayloadSignalDescriptors) {
      expect(f.key).toBeTruthy();
      expect(f.description).toBeTruthy();
      expect(["string", "number", "boolean", "string[]", "timestamp"]).toContain(f.type);
      expect(f).not.toHaveProperty("name");
      expect(f).not.toHaveProperty("defaultBound");
    }
  });

  it("satisfies PayloadSignalDescriptor type", () => {
    const descriptors: PayloadSignalDescriptor[] = gitPayloadSignalDescriptors;
    expect(descriptors).toBe(gitPayloadSignalDescriptors);
  });
});
