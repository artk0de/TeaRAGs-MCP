/**
 * The intra-file mass-commit fence (bd tea-rags-mcp-3gz4f design point 1):
 * the chunk walk has no mass-change cut, so the read side draws one — a commit
 * touching more of the file's symbols than a Tukey fence over the file's own
 * symbols-per-commit distribution is a formatter run / rename sweep, pairs
 * every symbol with every other, and leaves the analysis before any pair is
 * counted.
 */

import { describe, expect, it } from "vitest";

import type { TemporalSymbolCommitFileSnapshot } from "../../../../../../../src/core/contracts/types/codegraph.js";
import { fenceMassCommits } from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/cohesion/mass-commit-fence.js";

const snapshot = (symbols: [string, string[]][]): TemporalSymbolCommitFileSnapshot => ({
  relPath: "src/a.ts",
  symbols: symbols.map(([symbolId, commitShas]) => ({ symbolId, commitShas })),
});

describe("fenceMassCommits", () => {
  it("drops a commit that touches every symbol of the file", () => {
    // Four ordinary commits pair the symbols two at a time; sFmt is the
    // formatter run over all six.
    const rows = snapshot([
      ["A#one", ["s1", "s2", "sFmt"]],
      ["A#two", ["s1", "s2", "sFmt"]],
      ["A#three", ["s3", "s4", "sFmt"]],
      ["A#four", ["s3", "s4", "sFmt"]],
      ["A#five", ["s5", "s6", "sFmt"]],
      ["A#six", ["s5", "s6", "sFmt"]],
    ]);

    const fenced = fenceMassCommits(rows);

    expect(fenced.droppedCommits).toBe(1);
    for (const [, shas] of fenced.symbols) expect(shas.has("sFmt")).toBe(false);
    expect(fenced.symbols.get("A#one")).toEqual(new Set(["s1", "s2"]));
  });

  it("keeps a small file whose every commit touches both symbols", () => {
    // Sample = [2, 2]: the fence sits at the definitional floor, count-2
    // commits are admitted — a two-method file changed only together is ONE
    // cluster, and the fence must not manufacture a split.
    const rows = snapshot([
      ["A#one", ["s1", "s2", "s3"]],
      ["A#two", ["s1", "s2", "s3"]],
    ]);

    const fenced = fenceMassCommits(rows);

    expect(fenced.droppedCommits).toBe(0);
    expect(fenced.symbols.get("A#one")).toEqual(new Set(["s1", "s2", "s3"]));
  });

  it("leaves nothing when no commit touches more than one symbol", () => {
    // No pair-bearing sample exists; the fence has nothing to cut.
    const rows = snapshot([
      ["A#one", ["s1", "s2"]],
      ["A#two", ["s3"]],
    ]);

    const fenced = fenceMassCommits(rows);

    expect(fenced.droppedCommits).toBe(0);
    expect(fenced.symbols.get("A#one")).toEqual(new Set(["s1", "s2"]));
    expect(fenced.symbols.get("A#two")).toEqual(new Set(["s3"]));
  });

  it("excludes symbols whose every commit the fence dropped", () => {
    // Eight symbols paired off by ordinary commits; the two sweeps touch all
    // eight and sit far above the fence (sample [2×8, 8, 8] → cut 2).
    const rows = snapshot([
      ["A#a", ["s1", "s2", "sFmt1", "sFmt2"]],
      ["A#b", ["s1", "s2", "sFmt1", "sFmt2"]],
      ["A#c", ["s3", "s4", "sFmt1", "sFmt2"]],
      ["A#d", ["s3", "s4", "sFmt1", "sFmt2"]],
      ["A#e", ["s5", "s6", "sFmt1", "sFmt2"]],
      ["A#f", ["s5", "s6", "sFmt1", "sFmt2"]],
      ["A#g", ["s7", "s8", "sFmt1", "sFmt2"]],
      ["A#h", ["s7", "s8", "sFmt1", "sFmt2"]],
      // Changed ONLY in the sweeps — the fence empties it out of the analysis.
      ["A#swept", ["sFmt1", "sFmt2"]],
    ]);

    const fenced = fenceMassCommits(rows);

    expect(fenced.droppedCommits).toBe(2);
    expect(fenced.symbols.has("A#swept")).toBe(false);
    expect(fenced.symbols.get("A#a")).toEqual(new Set(["s1", "s2"]));
  });
});
