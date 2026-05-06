import { describe, expect, it } from "vitest";

import type { BlameLine } from "../../../../../../src/core/adapters/git/types.js";
import {
  computeBlameOwnership,
  type BlameOwnership,
} from "../../../../../../src/core/domains/trajectory/git/infra/blame-ownership.js";

function makeLine(
  lineNumber: number,
  author: string,
  sha: string = author.toLowerCase().repeat(40).slice(0, 40),
): BlameLine {
  return {
    lineNumber,
    sha,
    author,
    authorEmail: `${author.toLowerCase()}@example.com`,
    timestamp: 1700000000,
  };
}

describe("computeBlameOwnership — file-level aggregation", () => {
  it("returns unknown owner on empty input", () => {
    const result = computeBlameOwnership([]);

    expect(result.file).toEqual<BlameOwnership>({
      blameDominantAuthor: "unknown",
      blameDominantAuthorPct: 0,
      blameAuthors: [],
      blameContributorCount: 0,
    });
    expect(result.chunks.size).toBe(0);
  });

  it("returns 100% for single-author file", () => {
    const lines = [makeLine(1, "Alice"), makeLine(2, "Alice"), makeLine(3, "Alice")];

    const { file } = computeBlameOwnership(lines);

    expect(file.blameDominantAuthor).toBe("Alice");
    expect(file.blameDominantAuthorPct).toBe(100);
    expect(file.blameAuthors).toEqual(["Alice"]);
    expect(file.blameContributorCount).toBe(1);
  });

  it("computes share by lines, not commits (3 Alice / 2 Bob = 60% Alice)", () => {
    const lines = [
      makeLine(1, "Alice"),
      makeLine(2, "Alice"),
      makeLine(3, "Alice"),
      makeLine(4, "Bob"),
      makeLine(5, "Bob"),
    ];

    const { file } = computeBlameOwnership(lines);

    expect(file.blameDominantAuthor).toBe("Alice");
    expect(file.blameDominantAuthorPct).toBe(60);
    expect(file.blameContributorCount).toBe(2);
    // blameAuthors sorted by share desc
    expect(file.blameAuthors).toEqual(["Alice", "Bob"]);
  });

  it("caps blameAuthors at 10 contributors (top-N by line count)", () => {
    const lines: BlameLine[] = [];
    // Top author: Alice with 100 lines
    for (let i = 1; i <= 100; i++) lines.push(makeLine(i, "Alice"));
    // 14 minor contributors with descending counts
    for (let n = 0; n < 14; n++) {
      const count = 14 - n;
      const author = `Author${String(n).padStart(2, "0")}`;
      for (let k = 0; k < count; k++) lines.push(makeLine(101 + n * 100 + k, author));
    }

    const { file } = computeBlameOwnership(lines);

    expect(file.blameContributorCount).toBe(15); // Alice + 14 others
    expect(file.blameAuthors).toHaveLength(10); // capped
    expect(file.blameAuthors[0]).toBe("Alice");
    // Top-N retains highest contributors first
    expect(file.blameAuthors[1]).toBe("Author00"); // 14 lines
    expect(file.blameAuthors[9]).toBe("Author08"); // 6 lines
  });
});

describe("computeBlameOwnership — chunk-level aggregation", () => {
  const lines: BlameLine[] = [
    makeLine(1, "Alice"),
    makeLine(2, "Alice"),
    makeLine(3, "Bob"),
    makeLine(4, "Bob"),
    makeLine(5, "Bob"),
    makeLine(6, "Carol"),
  ];

  it("filters blame lines by chunk range and aggregates per chunk", () => {
    const chunkRanges = [
      { chunkId: "chunk-a", startLine: 1, endLine: 2 },
      { chunkId: "chunk-b", startLine: 3, endLine: 5 },
      { chunkId: "chunk-c", startLine: 6, endLine: 6 },
    ];

    const { chunks } = computeBlameOwnership(lines, chunkRanges);

    expect(chunks.get("chunk-a")?.blameDominantAuthor).toBe("Alice");
    expect(chunks.get("chunk-a")?.blameDominantAuthorPct).toBe(100);

    expect(chunks.get("chunk-b")?.blameDominantAuthor).toBe("Bob");
    expect(chunks.get("chunk-b")?.blameDominantAuthorPct).toBe(100);
    expect(chunks.get("chunk-b")?.blameContributorCount).toBe(1);

    expect(chunks.get("chunk-c")?.blameDominantAuthor).toBe("Carol");
  });

  it("produces unknown ownership for chunk range with no covering blame lines", () => {
    const chunkRanges = [{ chunkId: "ghost-chunk", startLine: 100, endLine: 200 }];

    const { chunks } = computeBlameOwnership(lines, chunkRanges);

    expect(chunks.get("ghost-chunk")).toEqual<BlameOwnership>({
      blameDominantAuthor: "unknown",
      blameDominantAuthorPct: 0,
      blameAuthors: [],
      blameContributorCount: 0,
    });
  });

  it("includes endLine inclusively (range is [start, end])", () => {
    // chunk covering only line 5 (Bob)
    const chunkRanges = [{ chunkId: "single-line", startLine: 5, endLine: 5 }];

    const { chunks } = computeBlameOwnership(lines, chunkRanges);

    expect(chunks.get("single-line")?.blameDominantAuthor).toBe("Bob");
    expect(chunks.get("single-line")?.blameContributorCount).toBe(1);
  });

  it("returns empty chunks map when chunkRanges argument is omitted", () => {
    const { chunks } = computeBlameOwnership(lines);

    expect(chunks.size).toBe(0);
  });

  it("aggregates mixed-author chunk by line share", () => {
    // chunk lines 2-4: Alice(1) + Bob(2) → Bob 67%
    const chunkRanges = [{ chunkId: "mixed", startLine: 2, endLine: 4 }];

    const { chunks } = computeBlameOwnership(lines, chunkRanges);

    const mixed = chunks.get("mixed")!;
    expect(mixed.blameDominantAuthor).toBe("Bob");
    expect(mixed.blameDominantAuthorPct).toBe(67); // round(2/3 * 100) = 67
    expect(mixed.blameContributorCount).toBe(2);
    expect(mixed.blameAuthors).toEqual(["Bob", "Alice"]);
  });
});
