/**
 * The run-scoped symbol-commit buffer (bd tea-rags-mcp-3gz4f): what the git
 * provider absorbs per batch and the temporal hook drains at completion.
 *
 * Invariants under test:
 *   - absorbing the same symbol twice UNIONS its commit sets — the batches of
 *     one file arrive separately and saw disjoint chunks of that symbol;
 *   - drainFiles returns one snapshot per file, insertion-ordered, and
 *     empties the buffer;
 *   - different files never merge.
 */
import { describe, expect, it } from "vitest";

import { InMemoryTemporalSymbolCommitBuffer } from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

function m(entries: [string, string[]][]): Map<string, Set<string>> {
  return new Map(entries.map(([k, v]) => [k, new Set(v)]));
}

describe("InMemoryTemporalSymbolCommitBuffer", () => {
  it("unions repeated absorbs of one symbol and keeps files apart", () => {
    const buffer = new InMemoryTemporalSymbolCommitBuffer();

    buffer.absorb("src/a.ts", m([["A#one", ["s1", "s2"]]]));
    buffer.absorb("src/b.ts", m([["B#run", ["s3"]]]));
    // Second batch: another chunk of A#one, seen with one more commit.
    buffer.absorb(
      "src/a.ts",
      m([
        ["A#one", ["s2", "s9"]],
        ["A#two", ["s2"]],
      ]),
    );

    expect(buffer.drainFiles()).toEqual([
      {
        relPath: "src/a.ts",
        symbols: [
          { symbolId: "A#one", commitShas: expect.arrayContaining(["s1", "s2", "s9"]) },
          { symbolId: "A#two", commitShas: ["s2"] },
        ],
      },
      { relPath: "src/b.ts", symbols: [{ symbolId: "B#run", commitShas: ["s3"] }] },
    ]);
  });

  it("empties on drain so the next run starts clean", () => {
    const buffer = new InMemoryTemporalSymbolCommitBuffer();
    buffer.absorb("src/a.ts", m([["A#one", ["s1"]]]));

    expect(buffer.drainFiles()).toHaveLength(1);
    expect(buffer.drainFiles()).toEqual([]);
  });

  it("snapshots are decoupled from later absorbs", () => {
    const buffer = new InMemoryTemporalSymbolCommitBuffer();
    buffer.absorb("src/a.ts", m([["A#one", ["s1"]]]));
    const [first] = buffer.drainFiles();

    buffer.absorb("src/a.ts", m([["A#one", ["s2"]]]));

    expect(first.symbols[0].commitShas).toEqual(["s1"]);
  });
});
