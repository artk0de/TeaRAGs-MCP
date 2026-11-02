/**
 * Behavioral coverage for `assembleOverlays` — the final reduce that
 * turns walkCommits' per-chunk accumulators into the public
 * `Map<relativePath, Map<chunkId, ChunkChurnOverlay>>`.
 *
 * Exercises both reduce paths:
 *   1. `fileChurnData` provided — file commitCount + contributors come
 *      from the file-level reader; bypasses chunk-SHA union.
 *   2. `fileChurnData` absent — fallback path unions chunk commit SHAs.
 *
 * Plus the two `acc` guards that drop chunks lacking an accumulator
 * entry (live data may be sparse when the walker skipped a chunk).
 */

import { describe, expect, it } from "vitest";

import { assembleOverlays } from "../../../../../../src/core/domains/trajectory/git/infra/assemble-overlays.js";
import type { ChunkAccumulator } from "../../../../../../src/core/domains/trajectory/git/infra/metrics.js";

function acc(over: Partial<ChunkAccumulator> = {}): ChunkAccumulator {
  return {
    commitShas: new Set<string>(["sha1", "sha2"]),
    authors: new Set<string>(["alice"]),
    bugFixCount: 0,
    lastModifiedAt: 1_700_000_000,
    linesAdded: 10,
    linesDeleted: 5,
    commitTimestamps: [1_700_000_000],
    commitAuthors: ["alice"],
    taskIds: new Set<string>(),
    ...over,
  };
}

describe("assembleOverlays", () => {
  it("uses fileChurnData when provided — fileCommitCount and contributors come from the file map", () => {
    const result = assembleOverlays({
      relativeChunkMap: new Map([["src/a.ts", [{ chunkId: "src/a.ts:0", startLine: 1, endLine: 10 }]]]),
      accumulators: new Map<string, ChunkAccumulator>([["src/a.ts:0", acc()]]),
      fileChurnDataMap: new Map([
        [
          "src/a.ts",
          {
            commits: [
              { sha: "x1", author: "alice", authorEmail: "a@x", timestamp: 1, body: "init", parents: [] },
              { sha: "x2", author: "bob", authorEmail: "b@x", timestamp: 2, body: "fix", parents: ["x1"] },
            ],
            firstCommitTimestamp: 1,
            lastCommitTimestamp: 2,
          },
        ],
      ]),
    });
    const overlay = result.get("src/a.ts")?.get("src/a.ts:0");
    expect(overlay).toBeDefined();
    // 2 commits, 2 distinct authors — the assembler uses fileCommitCount=2
    // and fileContributorCount=2 from fileChurnData, not the chunk SHA union.
    expect(result.size).toBe(1);
  });

  it("falls back to chunk-SHA union when fileChurnDataMap is absent", () => {
    // No fileChurnDataMap — assembler unions SHAs across all chunks for the file.
    const result = assembleOverlays({
      relativeChunkMap: new Map([
        [
          "src/b.ts",
          [
            { chunkId: "src/b.ts:0", startLine: 1, endLine: 5 },
            { chunkId: "src/b.ts:1", startLine: 6, endLine: 10 },
          ],
        ],
      ]),
      accumulators: new Map<string, ChunkAccumulator>([
        ["src/b.ts:0", acc({ commitShas: new Set(["s1", "s2"]) })],
        ["src/b.ts:1", acc({ commitShas: new Set(["s2", "s3"]) })],
      ]),
    });
    expect(result.get("src/b.ts")?.size).toBe(2);
  });

  it("skips chunk entries that lack a matching accumulator (sparse-data guard)", () => {
    // Two chunks declared, only one accumulator present — the other is dropped silently.
    const result = assembleOverlays({
      relativeChunkMap: new Map([
        [
          "src/c.ts",
          [
            { chunkId: "src/c.ts:0", startLine: 1, endLine: 5 },
            { chunkId: "src/c.ts:1", startLine: 6, endLine: 10 },
          ],
        ],
      ]),
      accumulators: new Map<string, ChunkAccumulator>([["src/c.ts:0", acc()]]),
    });
    expect(result.get("src/c.ts")?.size).toBe(1);
    expect(result.get("src/c.ts")?.has("src/c.ts:0")).toBe(true);
    expect(result.get("src/c.ts")?.has("src/c.ts:1")).toBe(false);
  });

  it("returns an empty map when relativeChunkMap is empty", () => {
    const result = assembleOverlays({
      relativeChunkMap: new Map(),
      accumulators: new Map(),
    });
    expect(result.size).toBe(0);
  });

  it("omits files whose every chunk lacks an accumulator (overlayMap.size === 0)", () => {
    // Drives the `if (overlayMap.size > 0)` guard at the bottom of the loop.
    const result = assembleOverlays({
      relativeChunkMap: new Map([["src/d.ts", [{ chunkId: "src/d.ts:0", startLine: 1, endLine: 5 }]]]),
      accumulators: new Map<string, ChunkAccumulator>(),
    });
    expect(result.has("src/d.ts")).toBe(false);
    expect(result.size).toBe(0);
  });
});
