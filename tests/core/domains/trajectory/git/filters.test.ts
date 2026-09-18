import { describe, expect, it } from "vitest";

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
  it("exports 11 filter descriptors", () => {
    expect(gitFilters).toHaveLength(11);
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

describe("level-aware filters", () => {
  // ageDays 0 = last commit less than 24h before enrichment (day-floored), NOT
  // "no git data": both assemblers leave the key absent when there is no
  // history, and the is_empty guard below is what excludes those points.
  it("minAgeDays uses level-aware key with is_empty guard", () => {
    const chunkLevel = findFilter("minAgeDays").toCondition(30);
    expect(chunkLevel.must![0]).toEqual({
      key: "git.chunk.ageDays",
      range: { gte: 30 },
    });
    // Guard: exclude points where field is missing (Qdrant skips range on undefined)
    expect(chunkLevel.must_not![0]).toEqual({ is_empty: { key: "git.chunk.ageDays" } });

    const fileLevel = findFilter("minAgeDays").toCondition(30, "file");
    expect(fileLevel.must![0].key).toBe("git.file.ageDays");
    expect(fileLevel.must_not![0]).toEqual({ is_empty: { key: "git.file.ageDays" } });
  });

  it("maxAgeDays uses level-aware key with is_empty guard", () => {
    const chunkLevel = findFilter("maxAgeDays").toCondition(90);
    expect(chunkLevel.must![0]).toEqual({
      key: "git.chunk.ageDays",
      range: { lte: 90 },
    });
    expect(chunkLevel.must_not![0]).toEqual({ is_empty: { key: "git.chunk.ageDays" } });

    const fileLevel = findFilter("maxAgeDays").toCondition(7, "file");
    expect(fileLevel.must![0].key).toBe("git.file.ageDays");
    expect(fileLevel.must_not![0]).toEqual({ is_empty: { key: "git.file.ageDays" } });
  });

  it("maxAgeDays admits ageDays 0 — code committed less than a day before enrichment is the freshest, not unknown", () => {
    const fileLevel = findFilter("maxAgeDays").toCondition(7, "file");
    expect(fileLevel.must).toEqual([{ key: "git.file.ageDays", range: { lte: 7 } }]);
  });

  it("maxAgeDays compiles the same chunk range as the freshLegacyEdits filter preset", () => {
    const presetFilter = compileFilterPreset(freshLegacyEditsFilterPreset, undefined, "chunk");
    const presetChunkAge = presetFilter.must!.find((c) => "key" in c && c.key === "git.chunk.ageDays");
    expect(findFilter("maxAgeDays").toCondition(7).must![0]).toEqual(presetChunkAge);
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
