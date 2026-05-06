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
      lineDominantAuthor: "unknown",
      lineDominantAuthorPct: 0,
      lineAuthors: [],
      lineContributorCount: 0,
    });
    expect(result.chunks.size).toBe(0);
  });

  it("returns 100% for single-author file", () => {
    const lines = [makeLine(1, "Alice"), makeLine(2, "Alice"), makeLine(3, "Alice")];

    const { file } = computeBlameOwnership(lines);

    expect(file.lineDominantAuthor).toBe("Alice");
    expect(file.lineDominantAuthorPct).toBe(100);
    expect(file.lineAuthors).toEqual(["Alice"]);
    expect(file.lineContributorCount).toBe(1);
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

    expect(file.lineDominantAuthor).toBe("Alice");
    expect(file.lineDominantAuthorPct).toBe(60);
    expect(file.lineContributorCount).toBe(2);
    // lineAuthors sorted by share desc
    expect(file.lineAuthors).toEqual(["Alice", "Bob"]);
  });

  it("caps lineAuthors at 10 contributors (top-N by line count)", () => {
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

    expect(file.lineContributorCount).toBe(15); // Alice + 14 others
    expect(file.lineAuthors).toHaveLength(10); // capped
    expect(file.lineAuthors[0]).toBe("Alice");
    // Top-N retains highest contributors first
    expect(file.lineAuthors[1]).toBe("Author00"); // 14 lines
    expect(file.lineAuthors[9]).toBe("Author08"); // 6 lines
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

    expect(chunks.get("chunk-a")?.lineDominantAuthor).toBe("Alice");
    expect(chunks.get("chunk-a")?.lineDominantAuthorPct).toBe(100);

    expect(chunks.get("chunk-b")?.lineDominantAuthor).toBe("Bob");
    expect(chunks.get("chunk-b")?.lineDominantAuthorPct).toBe(100);
    expect(chunks.get("chunk-b")?.lineContributorCount).toBe(1);

    expect(chunks.get("chunk-c")?.lineDominantAuthor).toBe("Carol");
  });

  it("produces unknown ownership for chunk range with no covering blame lines", () => {
    const chunkRanges = [{ chunkId: "ghost-chunk", startLine: 100, endLine: 200 }];

    const { chunks } = computeBlameOwnership(lines, chunkRanges);

    expect(chunks.get("ghost-chunk")).toEqual<BlameOwnership>({
      lineDominantAuthor: "unknown",
      lineDominantAuthorPct: 0,
      lineAuthors: [],
      lineContributorCount: 0,
    });
  });

  it("includes endLine inclusively (range is [start, end])", () => {
    // chunk covering only line 5 (Bob)
    const chunkRanges = [{ chunkId: "single-line", startLine: 5, endLine: 5 }];

    const { chunks } = computeBlameOwnership(lines, chunkRanges);

    expect(chunks.get("single-line")?.lineDominantAuthor).toBe("Bob");
    expect(chunks.get("single-line")?.lineContributorCount).toBe(1);
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
    expect(mixed.lineDominantAuthor).toBe("Bob");
    expect(mixed.lineDominantAuthorPct).toBe(67); // round(2/3 * 100) = 67
    expect(mixed.lineContributorCount).toBe(2);
    expect(mixed.lineAuthors).toEqual(["Bob", "Alice"]);
  });
});
