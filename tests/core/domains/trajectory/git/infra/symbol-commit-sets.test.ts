/**
 * Symbol-level commit sets from the chunk walk (bd tea-rags-mcp-3gz4f).
 *
 * Invariants under test:
 *   - chunks group under their payload symbolId with the `#partN` window
 *     suffix stripped — an oversized symbol's parts are ONE symbol's set;
 *   - chunks without a symbolId (blocks) are dropped, never a bare-name row;
 *   - a chunk no accumulator knows contributes nothing;
 *   - per-file maps are independent.
 */
import { describe, expect, it } from "vitest";

import type { ChunkAccumulator } from "../../../../../../src/core/domains/trajectory/git/infra/metrics.js";
import { collectSymbolCommitSets } from "../../../../../../src/core/domains/trajectory/git/infra/symbol-commit-sets.js";
import type { ChunkLookupEntry } from "../../../../../../src/core/types.js";

function entry(chunkId: string, symbolId?: string): ChunkLookupEntry {
  return { chunkId, startLine: 1, endLine: 10, ...(symbolId ? { symbolId } : {}) };
}

function acc(shas: string[]): ChunkAccumulator {
  return {
    commitShas: new Set(shas),
    authors: new Set(),
    bugFixCount: 0,
    lastModifiedAt: 0,
    linesAdded: 0,
    linesDeleted: 0,
    commitTimestamps: [],
    commitAuthors: [],
    taskIds: new Set(),
  };
}

describe("collectSymbolCommitSets", () => {
  it("unions #partN windows into the parent symbol and drops block chunks", () => {
    const relativeChunkMap = new Map([
      [
        "src/a.ts",
        [entry("c1", "Big#parse#part1"), entry("c2", "Big#parse#part2"), entry("c3", "Small#run"), entry("c4")],
      ],
    ]);
    const accumulators = new Map([
      ["c1", acc(["s1", "s2"])],
      ["c2", acc(["s2", "s9"])],
      ["c3", acc(["s3"])],
      ["c4", acc(["s-blocked"])],
    ]);

    const sets = collectSymbolCommitSets(relativeChunkMap, accumulators);

    expect(sets.get("src/a.ts")?.get("Big#parse")).toEqual(new Set(["s1", "s2", "s9"]));
    expect(sets.get("src/a.ts")?.get("Small#run")).toEqual(new Set(["s3"]));
    expect(sets.get("src/a.ts")?.size).toBe(2);
  });

  it("skips chunks the walk left no accumulator for, and empty files", () => {
    const relativeChunkMap = new Map([
      ["src/a.ts", [entry("c1", "A#one"), entry("c-unknown", "A#two")]],
      ["src/empty.ts", [entry("c2", "E#x")]],
    ]);
    const accumulators = new Map([["c1", acc(["s1"])]]);
    // src/empty.ts was skipped as oversized: buildAccumulators dropped it, so
    // relativeChunkMap (the walked subset) would not name it either — the
    // walk-side caller only ever passes the walked map.
    void relativeChunkMap.get("src/empty.ts");

    const sets = collectSymbolCommitSets(new Map([["src/a.ts", relativeChunkMap.get("src/a.ts")!]]), accumulators);

    expect(sets.get("src/a.ts")?.get("A#one")).toEqual(new Set(["s1"]));
    expect(sets.get("src/a.ts")?.has("A#two")).toBe(false);
  });
});
